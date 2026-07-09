/**
 * game/dungeon/abilities.js — the HERO ABILITY SYSTEM: everything a hero can
 * DO on their turn. Factory mixin on Dungeon.prototype: _useAtwill (Melee/
 * Ranged modes) / _basicAttack / _playerAttack (+ _attackOffsets, cleave,
 * spirit weapon, bow feats), _useAbility + the effect dispatcher, every _ab*
 * handler (spells, maneuvers, domain powers), the castable/loadout/domain
 * plumbing (_computeCastable/_domainSetup/_abilitiesFor + the Spellbook,
 * Domain and progression picker actions), spell math (_spellDC/_spellDice/
 * _rollSpell/_slotLevelFor) and PF1 Spell Resistance (_srBlocks/_srBlocksHero),
 * plus the shared resolution helpers that rode along (_enemyTargets/_enemyAC/
 * _enemySave/_saveVs, dispel checks).
 * PF1CORE: the pure math (_spellDC, SR checks, _spellDice scaling, dispel
 * eligibility) migrates coreward in the consolidation sweep — targeting,
 * narration and turn glue stay here.
 * Factory takes Dungeon tuning consts + tiny shared predicates (see the
 * destructure below). 2026-07-04: born in the Phase-2 mixin split — bodies
 * moved VERBATIM from Dungeon.js (seam 4 of 4).
 */
const db = require('../../persistence/db');
const { weaponOf, SND, dRoll, dRollN, pick } = require('../combat');
const { kitFor, roomUses, isPoolClass, isCaster, isSpontaneous, spellSlots, slotsFor, diceCount, CANTRIPS, CANTRIP_BY_KEY } = require('../../pf1data/abilities');
const { babFor, weaponProficient, NON_PROFICIENT_PENALTY } = require('../../pf1data/classes');
const { crToNum, SIZE_RANK, SIZE_NAME, MONK_SFX } = require('../../pf1data/monsters');
const RACES = require('../../pf1data/races');
const { DOMAINS, maxDomainsFor } = require('../../pf1data/domains');
const { fighterFeats } = require('../../pf1data/feats');
const loadouts = require('../../pf1data/loadouts');
const banter = require('../../bot/banter');

// BATTLE DANCE (Dawnflower Dervish) — a bard whose Inspire Courage does NOT aid
// allies but affects ONLY himself, at DOUBLE value. Keyed by player_id. Femmik
// Embersword is the Dervish; see _maintainBardSongs. (House style: same shape as
// UNDEAD_HEROES / the finesse-weapon sets.)
const BATTLE_DANCERS = new Set(['femmik embersword']);

// ── DOMAIN granted powers (DOMAINS-DESIGN.md §2/§3.3) ───────────────────────
// The ACTIVE powers, injected as synthetic room-cost abilities AFTER the class
// kit (_abilitiesFor) so the existing slot-index pipeline (buttons, blind menu,
// uses display) carries them for free. Uses = 3 + Wis per room (PF1 "3+Wis/day";
// the room is the game's day). Passive auras (Healing/Sun) and the auto-firing
// Liberation pool are flags set in _domainSetup, not entries here.
const DOM_USES = (lvl, m) => 3 + Math.max(0, (m && m.mods && m.mods.wis) || 0);
const DOMAIN_POWERS = {
  attackbuff: { key: 'dom_strength', name: 'Strength Surge', icon: '💪', cost: 'room', effect: 'domstrike', target: 'self', uses: DOM_USES, sound: '/audio/spell_buff_invoke.mp3', desc: 'Domain (Strength): surge with divine might — +½ level to hit AND damage on your next attack action.' },
  smite:      { key: 'dom_war', name: 'Battle Rage', icon: '⚔️', cost: 'room', effect: 'domsmite', target: 'self', uses: DOM_USES, sound: '/audio/spell_buff_invoke.mp3', desc: 'Domain (War): a battle-blessing — +level damage on your next attack action.' },
  reroll:     { key: 'dom_luck', name: 'Good Fortune', icon: '🍀', cost: 'room', effect: 'domfortune', target: 'self', uses: DOM_USES, sound: '/audio/spell_buff_invoke.mp3', desc: 'Domain (Luck): fortune favors you — your next MISSED attack is rerolled (keep the better).' },
  saveward:   { key: 'dom_protection', name: 'Resistant Touch', icon: '🛡️', cost: 'room', effect: 'domward', target: 'ally', uses: DOM_USES, sound: '/audio/spell_buff_invoke.mp3', desc: 'Domain (Protection): ward an ally (or yourself) — +2 on ALL saves for 3 rounds.' },
  bleed:      { key: 'dom_death', name: 'Bleeding Touch', icon: '💀', cost: 'room', effect: 'dombleed', target: 'self', uses: DOM_USES, sound: '/audio/spell_buff_invoke.mp3', desc: 'Domain (Death): your next hit opens a wound that BLEEDS 1d6 each round until the foe falls.' },
  copycat:    { key: 'dom_trickery', name: 'Copycat', icon: '🎭', cost: 'room', effect: 'mirrorimage', target: 'self', uses: DOM_USES, sound: '/audio/spell_invisibility.mp3', desc: 'Domain (Trickery): conjure shimmering mirror-image decoys that soak incoming attacks (Copycat).' },
};

// THE THEURGE KIT (Kobold Press, Open Design — Tobias 2026-07-04): a dual
// arcane+divine PREPARED caster with the WIDEST spell selection in the game. The
// kit is the UNION of the real cleric (divine, WIS-based DCs) and wizard (arcane,
// INT-based DCs) kits — shallow COPIES tagged with `dcStat` (which ability score
// sets each save DC — see _spellDC) and `side` ('divine'/'arcane', so Spell
// Synthesis can pair one of each). No channel, no domains — a theurge isn't a
// cleric, so those grant paths never fire. Built once and memoized, but it reads
// kitFor() live so it tracks any future kit edit. Buff/dispel-forward by the nature
// of the source kits. Used by ANY cls==='theurge' (Celeb is the archetype; humans
// may now pick theurge) — NOT char-gated, so it works for every theurge.
// Metamagic auto-variants and martial feat-buffs are filtered out.
const THEURGE_SKIP = new Set(['channel', 'deadlyaim', 'powerattack', 'magicmissile_quick', 'fireball_int', 'fireball_emp', 'scorch_emp', 'cone_max', 'disint_max']);   // no channel (he isn't a cleric); drop metamagic auto-variants + martial feat-buffs
let _theurgeKit = null;
function theurgeKit() {
  if (_theurgeKit) return _theurgeKit;
  const cleric = kitFor('cleric').abilities.filter(a => !THEURGE_SKIP.has(a.key));
  const wizard = kitFor('wizard').abilities.filter(a => !THEURGE_SKIP.has(a.key));
  const cKeys = new Set(cleric.map(a => a.key)), wKeys = new Set(wizard.map(a => a.key));
  const seen = new Set(), out = [];
  const add = (a, dfltSide) => {
    if (seen.has(a.key)) return; seen.add(a.key);
    // A spell on BOTH class lists (Dispel Magic, Protection from Evil, Hold
    // Person…) is 'both' — it fills whichever HALF of his prepared casts he needs,
    // and its save DC rides his BETTER casting stat ("counts however he needs it").
    const both = cKeys.has(a.key) && wKeys.has(a.key);
    out.push({ ...a, side: both ? 'both' : dfltSide, dcStat: both ? 'best' : (dfltSide === 'arcane' ? 'int' : 'wis') });   // no char gate — any theurge (Celeb or a human) may cast these
  };
  for (const a of cleric) add(a, 'divine');
  for (const a of wizard) add(a, 'arcane');
  _theurgeKit = out;
  return _theurgeKit;
}

// SLAYER — Studied Target (ACG). A SWIFT-action mark (freeAction, no use limit):
// the slayer reads a foe's guard, and every attack they make against that MARKED
// foe gains +N insight to hit AND damage (N = 1 + 1 per 5 levels → +1/+2/+3/+4/+5
// at 1/5/10/15/20). Re-study any turn to switch foes; it holds until then or the
// room ends. Injected into the slayer kit (see _abilitiesFor); the bonus lands in
// _swingVsAC (attacker.studiedId === target.uid → studiedN).
const STUDIED_TARGET = { key: 'studiedtarget', name: 'Studied Target', icon: '🎯', cost: 'free', effect: 'studytarget', target: 'enemy', freeAction: true, desc: 'SWIFT: study a foe — +N to hit & damage against it (N = 1 + 1 per 5 levels). Re-study any turn to switch marks; lasts until then or the room ends.' };
// CAVALIER — Challenge: swear an oath against ONE foe; every strike against it deals
// +your cavalier level in DAMAGE this room (applied in _swingVsAC via challengedId/
// challengeN). A ROOM-cost ability (uses scale: 1 + 1 per 4 levels), so it's a
// limited, focused kill-order (unlike the slayer's at-will Studied Target).
const CHALLENGE = { key: 'challenge', name: 'Challenge', icon: '⚔️', cost: 'room', uses: (lvl) => 1 + Math.floor(((lvl || 1) - 1) / 4), effect: 'challenge', target: 'enemy', sound: '/audio/taunt_predator.mp3', desc: 'A cavalier\'s oath: name ONE foe your quarry — every strike you land on it this room deals +your level in bonus damage. Uses per room = 1 + 1 per 4 levels.' };
// ORDER OF THE FLAME (Lord Gweyir) — a FREE, unlimited challenge-and-strike in one. Char-gated;
// applies his CURRENT glory stack (+2×N damage / −2×N AC), then attacks; a KILL grows the stack
// for next turn. Chain kills (fodder is fair game!) to pump it, then unleash on a real threat.
const GLORIOUS_CHALLENGE = { key: 'gloriouschallenge', name: 'Glorious Challenge', icon: '🔥', cost: 'free', effect: 'gloriouschallenge', target: 'enemy', sound: '/audio/draugr_shout03_burning.mp3', char: 'Lord Gweyir', desc: 'ORDER OF THE FLAME: SELECT a foe, then Glorious Challenge to challenge it AND strike at once. Deals +2 damage / takes −2 AC per KILL you\'ve strung together this room (it compounds). Drop the foe and the bonus grows for next turn. Free & unlimited — pick off the weak to build the Flame, then loose it on the mighty.' };
// ORDER OF THE FLAME order ability — BLAZE OF GLORY (L15). PF1: a standard action for Cha-mod
// rounds granting +4 to attack (among movement perks that don't apply on the abstract grid);
// modeled here as a once-per-room self-buff of +4 to hit for the rest of the room. Char-gated +
// minLevel 15 like the other Flame deeds. (Foolhardy Rush L2 & Daunting Success L8 are passives
// wired in Dungeon.js: _isFlameCavalier / openDoor / _rollInitiative / _dauntingSuccess.)
const BLAZE_OF_GLORY = { key: 'blazeofglory', name: 'Blaze of Glory', icon: '☄️', cost: 'room', uses: 1, minLevel: 15, effect: 'buff', target: 'self', buff: { toHit: 4 }, sticky: true, char: 'Lord Gweyir', sound: '/audio/draugr_shout03_burning.mp3', desc: 'ORDER OF THE FLAME (L15): blaze up in a final surge of glory — +4 to ALL your attacks for the rest of the room. Once per room.' };

// Signature Spell Strike sounds per magus (keyed by dungeon nickname). Human
// magi (and any unlisted magus) fall back to the spell's default electric zap.
const MAGUS_SPELLSTRIKE_SFX = {
  Kate:    '/audio/spellstrike_boudicca.mp3',     // Kate Blackwood — "boudicca" battle cry
  Vaughan: '/audio/spellstrike_vaughan.mp3',      // Vaughan — Genji-style sword ult
  Toni:    '/audio/spellstrike_toni.mp3',         // Toni — arcane sword-lightning yell
};

module.exports = ({ ABILITY_MOD, CAST_MOD, SICKENED_PENALTY, SICKENED_ROUNDS, BLIND_ROUNDS, HIGH_GROUND_AC, EFFECT_CL_FLOOR, mindImmune, fightsNatural, isSneakClass, titleCase, ccd, stepDamage }) => ({
  // ── Ability system ───────────────────────────────────────────────────────
  // At-will: a weapon swing (martials) or a cantrip (full casters), every turn.
  // MELEE / RANGED buttons (Tobias 2026-07-03) send an explicit payload.mode:
  //   'melee'  → your weapon swing; REFUSED (action kept) if your weapon is
  //              ranged — switch weapons at the door instead.
  //   'ranged' → a caster's cantrip ray, a ranged weapon's shot, or the backup
  //              crossbow / signature sidearm for a melee martial.
  //   no mode  → the old smart auto (blind A key, queues, bots, AFK swings).
  _useAtwill(m, payload) {
    if (!m.greaterInvis) m.invisible = false;   // attacking breaks Invisibility — but NOT Greater Invisibility
    const mode = payload && payload.mode;
    if (mode === 'melee') {
      const w = weaponOf(m.gear, m.weaponKey);
      if (w.ranged) return { ok: false, error: `your ${w.label || m.weaponKey} is a RANGED weapon — use the Ranged attack (or switch weapons between runs)` };
      return this._playerAttack(m, payload.targetUid);
    }
    if (mode === 'ranged') {
      const at = kitFor(m.cls).atwill;
      if (at && at.effect === 'bolt') return this._abBolt(m, this._activeCantrip(m, payload.targetUid, at), payload.targetUid);
      return this._playerAttack(m, payload.targetUid, false, { forceRanged: true });
    }
    return this._basicAttack(m, payload.targetUid);
  },
  // The basic attack for any combatant (human input, bot turn, or AFK auto-swing)
  // — a caster's cantrip ray, or a weapon swing. A barbarian's swing chain-cleaves
  // (drops a foe → carve into a random next one). Chosen foe is first; chains random.
  _basicAttack(m, targetUid) {
    const forced = this._forcedFoe(m);   // taunted → attack is dragged onto the taunter
    if (forced) targetUid = forced.uid;
    const at = kitFor(m.cls).atwill;
    if (at && at.effect === 'bolt') return this._abBolt(m, this._activeCantrip(m, targetUid, at), targetUid);
    // Barbarians, and fighters with Improved Cleave (level 9+), carve through —
    // every foe their swing FELLS grants another swing (chains on kills only).
    // AZWRAITH takes Cleave EARLY (Tobias's spec: "cleave and improved cleave at pretty
    // early points") — he carves from level 4, ahead of the standard fighter ladder.
    if (m.cls === 'barbarian' || fighterFeats(m.cls, m.level, this._isRanged(m)).impCleave || (m.playerId === 'azwraith' && (m.level || 1) >= 4)) {
      const e = this.enemies.find(x => x.uid === targetUid && x.hp > 0) || this._targetableEnemies()[0];   // fall back to a REAL foe, never a summoned ally
      // Cleave is a MELEE sweep — vs an airborne target fall through to the
      // normal attack path (which draws the backup crossbow); no carving at the sky.
      if (e && !this._canReach(m, e)) return this._playerAttack(m, targetUid);
      if (e) return this._cleaveSweep(m, e, { followThrough: false });
      return;
    }
    return this._playerAttack(m, targetUid);
  },
  // One of the class's abilities (slot index). Gates on level + cost:
  //   'pool' → spend a shared spell slot; 'room' → spend its own use; 'free' → unlimited.
  _useAbility(m, slot, payload) {
    const ab = this._abilitiesFor(m)[slot];   // class kit + injected domain powers
    if (!ab) return { ok: false, error: 'no such ability' };
    if (!this._charAllows(ab, m)) return { ok: false, error: 'not your ability' };   // char-gated form (e.g. Rissa's Beast Mode)
    if (!this._loadoutAllows(ab, m)) return { ok: false, error: `${ab.name} isn't prepared` };   // PHASE C: prepared/known loadout gate
    const lvl = m.level || 1;
    if (ab.minLevel && lvl < ab.minLevel) return { ok: false, error: `${ab.name} needs level ${ab.minLevel}` };
    // Raise Dead / Resurrection are powerful rituals — only between rooms (out of
    // combat), EXCEPT the between-rounds ritual window (_endOfRoundRaise).
    if (ab.raiseDead && this.status === 'combat' && !this._roundRaise) return { ok: false, error: `${ab.name} can only be cast between rooms or as a round turns, not mid-round.` };
    // Dropping a Wild Shape form you're already in is FREE (no use spent, always allowed).
    const formOff = ab.effect === 'form' && ab.form && m.form && m.form.key === ab.form.key;
    if (ab.cost === 'pool' && (m.spellPool || 0) <= 0) return { ok: false, error: 'out of spell casts this room' };
    if (ab.cost === 'slot' && !this._slotAvail(m, ab, ab.slvl)) return { ok: false, error: (m.cls === 'theurge' && ab.side && ab.side !== 'both') ? `no ${ab.side} level-${ab.slvl || '?'} casts left this room` : `no level-${ab.slvl || '?'} spell slots left this room` };
    if (ab.cost === 'room' && !formOff && ((m.abilityUses && m.abilityUses[ab.key]) || 0) <= 0) return { ok: false, error: `${ab.name} is spent for this room` };
    if (ab.cost === 'run'  && ((m.runAbilityUses && m.runAbilityUses[ab.key]) || 0) <= 0) return { ok: false, error: `${ab.name} is already cast for this dungeon` };
    // Don't waste Sleep/Fascinate on a foe that's already asleep OR fascinated —
    // they share the same "out of the fight" state, so re-casting either one on
    // an already-entranced foe is wasted. Refuse the cast (the slot is kept) when
    // every chosen target is already down. Bots already pick un-CC'd foes; this
    // guards manual casts and the all-CC'd edge case.
    if (ab.effect === 'sleep' || ab.effect === 'fascinate') {
      const picked = this._enemyTargets(payload, ab.maxTargets || 3);
      if (picked.length && picked.every(e => e.fascinated)) return { ok: false, error: 'those foes are already asleep or fascinated' };
    }
    // EXPLICITLY-TARGETED buff / dispel: refuse — keeping the slot — when the
    // chosen target is invalid (an ally already wearing the buff, or a target
    // with no magic to dispel). The reason goes back to the caster as a toast
    // and is SPOKEN in blind mode. With no explicit target the cast falls
    // through to the same smart auto-pick the AI uses.
    if (payload && (payload.allyUid || payload.targetUid)) {
      const pickedId = payload.allyUid || payload.targetUid;
      if (ab.effect === 'buff' && ab.target === 'ally' && ab.sticky) {
        const t = this.livingParty().find(a => a.playerId === pickedId);
        if (t) {
          const flag = ab.persist ? 'runBuffApplied' : 'buffApplied';
          if (t[flag] && t[flag][ab.key]) return { ok: false, error: `${t.nickname} already has ${ab.name}` };
        }
      }
    }
    // DISPEL MAGIC targeting: an EXPLICIT pick (ally to un-debuff OR foe to
    // un-buff) is honored; an invalid pick is refused. With NO pick the cast
    // auto-targets the smartest option, but is REFUSED — slot kept — when there
    // is nothing to dispel ANYWHERE (no hostile magic on the party, no
    // enchantments on the foes). The reason is toasted + spoken in blind mode.
    if (ab.effect === 'cleanse') {
      const allyAfflicted = (a) => (a.paralyzed > 0) || (a.slowed > 0) || (a.blinded > 0);   // dispel/remove-paralysis candidates: SPELL effects (any paralysis passes here — Remove Paralysis takes non-spell paralysis too; _abCleanse sorts out which spell may clear what)
      const foeEnchanted = (e) => (e.hasted > 0) || !!(e.precast && e.precast.length) || !!e.invisible || (e.images > 0) || !!e.flyCast
        || !!(e.buffs && ((e.buffs.toHit || 0) > 0 || (e.buffs.dmg || 0) > 0 || (e.buffs.ac || 0) > 0 || (e.buffs.bonusDice || 0) > 0));
      const pickedId = payload && (payload.allyUid || payload.targetUid);
      if (pickedId) {
        const ta = this.livingParty().find(a => a.playerId === pickedId);
        const te = !ta && this.enemies.find(e => e.uid === payload.targetUid && e.hp > 0 && !e.summoned);
        if (ta && !allyAfflicted(ta)) return { ok: false, error: `${ta.nickname} has no hostile magic on them to dispel` };
        if (te && !foeEnchanted(te)) return { ok: false, error: `${te.name} has no enchantment to strip` };
      } else if (!this.livingParty().some(allyAfflicted) && !this._targetableEnemies().some(foeEnchanted)) {
        return { ok: false, error: 'nothing to dispel — no hostile magic on the party and no enchantments on the foes' };
      }
    }
    // DISARM only works on a manufactured weapon — refuse (keeping the action) vs a
    // foe that fights with natural weapons / unarmed (claws, fangs, fists). The
    // reason is toasted + spoken in blind mode.
    if (ab.effect === 'disarm') {
      const tgt = this._oneEnemy(payload);
      if (tgt && fightsNatural(tgt)) return { ok: false, error: `${tgt.name} fights with natural weapons — there's nothing to disarm.` };
    }
    // BANISHMENT only works on OUTSIDERS (PF1) — refuse (keeping the slot) vs a
    // creature of this world; the reason is toasted + spoken in blind mode.
    if (ab.onlyOutsiders) {
      const tgt = this._oneEnemy(payload);
      if (tgt && !(tgt.type === 'outsider' || /demon|devil|daemon|fiend/i.test(tgt.name || ''))) {
        return { ok: false, error: `${ab.name} only banishes OUTSIDERS — ${tgt.name} is of this world.` };
      }
    }
    // HOLD PERSON only seizes HUMANOIDS (PF1 RAW, Tobias 2026-07-03) — refuse
    // (keeping the slot) vs beasts, dragons, monstrous humanoids and worse.
    if (ab.onlyHumanoids) {
      const tgt = this._oneEnemy(payload);
      if (tgt && !this._isHumanoid(tgt)) {
        return { ok: false, error: `${ab.name} only holds HUMANOIDS — ${tgt.name} is no person.` };
      }
    }
    // MELEE MANEUVERS need to physically REACH the foe — a grounded hero can't
    // trip / disarm / bull rush / grapple / feint a flyer on the wing (Josh: you
    // could cheat down airborne sorcerers & dragons with these). Unlike a basic
    // attack there's no ranged fallback for a body-on-body maneuver, so refuse —
    // keeping the action — with a told-to-the-caster reason. (Cleave handles its
    // own reach above by drawing the backup crossbow.)
    const MELEE_MANEUVERS = new Set(['trip', 'disarm', 'bullrush', 'grapple', 'feint', 'reckless']);
    if (MELEE_MANEUVERS.has(ab.effect)) {
      const tgt = this._oneEnemy(payload);
      if (tgt && tgt.flying && !this._canReach(m, tgt)) {
        return { ok: false, error: `${tgt.name} is flying out of reach — you can't ${ab.name.toLowerCase()} a foe on the wing. Use a ranged attack or get airborne.` };
      }
    }
    // ── PF1: CASTING WHILE GRAPPLED needs a concentration check or the spell is LOST ──
    // DC = 10 + the grappler's CMB + the spell's (metamagic-adjusted) level. The caster
    // rolls d20 + caster level + casting-stat mod (+4 with Combat Casting, which PF1 lets
    // apply to grappled casting). Only SPELLS are gated (cost slot/pool) — not rage /
    // channel / judgment / maneuvers. Inquisitors (Liberation / freedom of movement) are
    // exempt: their grip never holds, so their casting is never disrupted. On a FAIL the
    // slot/pool is still spent (RAW) and the turn is consumed. (Josh, 2026-07-01.)
    if (m.grappled && !this._freedomOfMovement(m) && (ab.cost === 'slot' || ab.cost === 'pool')) {
      const slvl = this._slotLevelFor(m, ab) || ab.slvl || 0;
      const grapCMB = (m.grappleCMB != null) ? m.grappleCMB : (m.grappledCL || 0);
      const dc = 10 + grapCMB + slvl;
      const cc = fighterFeats(m.cls, m.level, this._isRanged(m)).combatCasting ? 4 : 0;
      const bonus = (m.level || 1) + (m.castingMod != null ? m.castingMod : CAST_MOD) + cc;
      const roll = dRoll(20), total = roll + bonus;
      if (total < dc) {
        if (ab.cost === 'pool') m.spellPool = Math.max(0, (m.spellPool || 0) - 1);
        else { const _L = this._slotLevelFor(m, ab); this._spendSlot(m, ab, _L); }
        this._note(`🪢 ${m.nickname} is grappled and can't hold the casting of ${ab.name} together — concentration fails. [d20 ${roll}+${bonus} = ${total} vs DC ${dc}] The spell is lost.`, pick(SND.whiffSword));
        this._echoToTable(); this._broadcast();
        return { ok: true, fizzled: true };
      }
    }
    m.flatFooted = false;   // acting ends flat-footed
    const D = {
      trip:        () => this._abTrip(m, payload),
      disarm:      () => this._abDisarm(m, payload),
      bullrush:    () => this._abBullRush(m, payload),
      grapple:     () => this._abGrapple(m, payload),
      spiritweapon: () => this._abSpiritWeapon(m, ab, payload),
      cleave:      () => this._abCleave(m, ab, payload),
      feint:       () => this._abFeint(m, payload),
      reckless:    () => this._abReckless(m, payload),
      buff:        () => this._abBuff(m, ab, payload),
      form:        () => this._abForm(m, ab),
      taunt:       () => this._abTaunt(m, ab),
      smite:       () => this._abSmite(m, ab),
      detectevil:  () => this._abDetectEvil(m, ab),
      heal:        () => this._abHeal(m, ab, payload),
      channelneg:  () => this._abChannelNeg(m, ab),
      revive:      () => this._abRevive(m, ab, payload),
      haste:       () => this._abHaste(m, ab),
      invisible:   () => this._abInvisible(m, ab, payload),
      magearmor:   () => this._abMageArmor(m, ab),
      overlandflight: () => this._abOverlandFlight(m, ab),
      infernalheal: () => this._abInfernalHeal(m, ab, payload),
      blacktentacles: () => this._abBlackTentacles(m, ab),
      savedie:     () => this._abSaveDie(m, ab, payload),
      judgment:    () => this._abJudgment(m, ab),
      bane:        () => this._abBane(m, ab, payload),
      cleanse:     () => this._abCleanse(m, ab, payload),
      aoe:         () => this._abAoe(m, ab, payload),
      disintegrate: () => this._abDisintegrate(m, ab, payload),
      bolt:        () => this._abBolt(m, ab, payload.targetUid),
      missile:     () => this._abMissile(m, ab, payload),
      touch:       () => this._abTouch(m, ab, payload),
      rays:        () => this._abRays(m, ab, payload),
      spellstrike: () => this._abSpellstrike(m, ab, payload),
      glitterdust: () => this._abGlitterdust(m, ab, payload),
      mirrorimage: () => this._abMirrorImage(m, ab),
      bladelash:   () => this._abBladeLash(m, ab, payload),
      bladeddash:  () => this._abBladedDash(m, ab, payload),
      dimensionalblade: () => this._abDimBlade(m, ab),
      save_debuff: () => this._abSaveDebuff(m, ab, payload),
      charm:       () => this._abCharm(m, ab, payload),
      dominate:    () => this._abDominate(m, ab, payload),
      summon:      () => this._abSummon(m, ab, payload),
      forcepush:   () => this._abForcePush(m, ab, payload),
      studytarget: () => this._abStudyTarget(m, ab, payload),
      challenge: () => this._abChallenge(m, ab, payload),
      gloriouschallenge: () => this._abGloriousChallenge(m, ab, payload),
      masscharm:   () => this._abMassCharm(m, ab, payload),
      exhaust:     () => this._abExhaust(m, ab, payload),
      prismatic:   () => this._abPrismatic(m, ab, payload),
      grease:      () => this._abGrease(m, ab, payload),
      fascinate:   () => this._abFascinate(m, ab, payload),
      sleep:       () => this._abSleep(m, ab, payload),
      slow:        () => this._abSlow(m, ab, payload),
      darkness:    () => this._abDarkness(m, ab),
      rapidshot:   () => this._abRapidShot(m, ab, payload),
      bullseye:    () => this._abBullseye(m, ab, payload),
      stunfist:    () => this._abStunningFist(m, ab, payload),
      // DOMAIN granted powers (DOMAINS-DESIGN.md Phase B)
      domstrike:   () => this._abDomStrike(m, ab),
      domsmite:    () => this._abDomSmite(m, ab),
      domfortune:  () => this._abDomFortune(m, ab),
      domward:     () => this._abDomWard(m, ab, payload),
      dombleed:    () => this._abDomBleed(m, ab),
      tpstrike:    () => this._abTpStrike(m, ab, payload),
    }[ab.effect];
    if (!D) return { ok: false, error: 'unknown ability' };
    // NEGATIVE ENERGY MENDS THE UNDEAD (PF1, Tobias 2026-07-04): a Touch of
    // Corruption / Vampiric Touch aimed at a vampire would only HEAL it.
    // Refuse the cast with a spoken reason and KEEP the action — same pattern
    // as the Melee/Ranged weapon refusals. (Bot targeting already skips these
    // via _spellWorksOn; this catches an explicit human pick.)
    if (ab.dtype === 'negative' && ab.target === 'enemy') {
      const _tn = this._oneEnemy(payload);
      if (_tn && _tn.type === 'undead') return { ok: false, error: `${ab.name} would only HEAL ${_tn.name} — negative energy mends the undead. Pick a living target.` };
    }
    // PF1 SPELL RESISTANCE — single-target hostile spells test the target's SR
    // BEFORE their handler runs (_abAoe tests per target inside). A blocked
    // cast still spends the slot and the action below, per PF1.
    const SR_SINGLE = new Set(['savedie', 'save_debuff', 'charm', 'dominate', 'touch', 'bolt', 'missile', 'rays', 'disintegrate', 'fascinate', 'slow', 'sleep', 'exhaust']);
    let _srStopped = false;
    if (ab.slvl != null && SR_SINGLE.has(ab.effect)) {
      const _t = this._oneEnemy(payload);
      if (_t && this._srBlocks(m, _t, ab)) { _srStopped = true; this._echoToTable(); this._broadcast(); }
    }
    if (!_srStopped) D();
    if (ab.cost === 'pool') m.spellPool = Math.max(0, (m.spellPool || 0) - 1);
    else if (ab.cost === 'slot') { const _L = this._slotLevelFor(m, ab); this._spendSlot(m, ab, _L); }   // metamagic draws from the HIGHER slot; theurge draws from the arcane/divine half
    else if (ab.cost === 'room' && !formOff) m.abilityUses[ab.key] = Math.max(0, ((m.abilityUses && m.abilityUses[ab.key]) || 0) - 1);
    else if (ab.cost === 'run') m.runAbilityUses[ab.key] = Math.max(0, ((m.runAbilityUses && m.runAbilityUses[ab.key]) || 0) - 1);
    if ((ab.target === 'enemy' || ab.target === 'aoe') && !m.greaterInvis) m.invisible = false;   // attacking breaks Invisibility (Greater persists)
    // A blaster (Elfrip the flame oracle) sometimes whoops "BOOM!" when a big
    // fire spell lands. Throttled like all dungeon banter (≤1/round, a chance).
    if (m.isBot && (ab.key === 'fireball' || ab.key === 'firesnake')) {
      try { this._tryBanter(m, 'cast_fire', { spell: ab.name }); } catch (_) {}
    }
    // ── ONE SWIFT ACTION PER TURN (PF1) — 2026-07-02 audit. The three quickened
    // paths below (Curator, Quicken Channel, metamagic Quicken) each had their own
    // once-flag, so they could STACK into 2-3 free actions a turn. m._swiftUsed is
    // the shared per-turn budget (reset at turn start with _curatorBuffUsed).
    // Curator (Gaspar's bastard sword): the FIRST buff SPELL each turn is quickened
    // to a SWIFT action — it's cast for free and the wielder keeps their turn for a
    // second buff or a strike. The second buff (or any other action) takes the turn
    // as normal. So a Curator-wielder can stack TWO buffs in a single turn.
    if (this._wieldsCurator(m) && this._isBuffSpell(ab) && !m._curatorBuffUsed && !m._swiftUsed) {
      m._curatorBuffUsed = true; m._swiftUsed = true;
      this._note(`📖 ${m.nickname}'s Curator quickens the casting — a swift action! (cast again or strike this turn)`);
      return { ok: true, freeAction: true };
    }
    // Cleric QUICKEN CHANNEL (feat tree n8): the FIRST party-heal channel each room
    // is a SWIFT action — the cleric keeps their turn to strike or cast.
    if (ab.effect === 'heal' && ab.heal === 'party' && !m._qcUsed && !m._swiftUsed && fighterFeats(m.cls, m.level, this._isRanged(m)).quickChannel) {
      m._qcUsed = true; m._swiftUsed = true;
      this._note(`✨ ${m.nickname} QUICKENS the channel — a swift action! (act again this turn)`);
      return { ok: true, freeAction: true };
    }
    // METAMAGIC QUICKEN: a quickened spell is a SWIFT action — the caster acts again
    // (cast a second spell, or strike). PF1: one swift action per turn, so it consumes
    // itself — the quicken toggle / bot one-shot clears after firing. If the swift is
    // already spent this turn, the spell still lands but costs the turn normally.
    if (ab.cost === 'slot' && this._mmForCast(m, ab).quicken) {
      if (m.metamagic) m.metamagic.quicken = false;
      if (m._botMM) m._botMM.quicken = false;
      if (m._swiftUsed) {
        this._note(`⚡ ${m.nickname}'s quickened casting lands — but their swift action is already spent, so the turn is used.`);
      } else {
        m._swiftUsed = true;
        this._note(`⚡ ${m.nickname} QUICKENS the casting — a swift action! (cast again or strike this turn)`);
        this._broadcast();
        return { ok: true, freeAction: true };
      }
    }
    if (ab.effect === 'judgment' || ab.freeAction) return { ok: true, freeAction: true };   // judgement switch / barbarian Rage cost no action
    return { ok: true };
  },
  /** True if this member wields Gaspar's bastard sword "Curator". */
  _wieldsCurator(m) { return !!(m && m.weaponKey === 'curator'); },
  /** A real BUFF SPELL (not a free combat toggle like Power Attack / Rage / Deadly
   *  Aim, and not a 0-cost trick) — what Curator's swift-cast applies to. */
  _isBuffSpell(ab) {
    if (!ab || ab.freeAction || ab.cost === 'free') return false;
    return ab.effect === 'buff' || ab.effect === 'haste';
  },
  /** Per-character ability gating: `char` restricts an ability to one named hero
   *  (Rissa's Beast Mode / Promethean); `notChar` hides it from that hero (the
   *  generic Tiger/Bear forms she replaces). Matched by nickname or playerId. */
  _charAllows(ab, m) {
    if (!ab || (!ab.char && !ab.notChar)) return true;
    const who = (m.trueNick || m.nickname || '').toLowerCase();
    const pid = (m.playerId || '').toLowerCase();
    if (ab.char)    { const c = ab.char.toLowerCase();    if (who !== c && pid !== c) return false; }
    if (ab.notChar) { const c = ab.notChar.toLowerCase(); if (who === c || pid === c) return false; }
    return true;
  },
  // ── PHASE C: prepared/known LOADOUT gating (SPELL-LOADOUTS-DESIGN.md). A leveled
  // spell is castable only if it's in the character's loadout — PREPARED casters use
  // their prepared list, SPONTANEOUS casters their known list (default known = the whole
  // implemented kit, so spontaneous casters are unaffected). Cantrips (no slvl) and
  // class FEATURES are always available. m.castableKeys is the precomputed Set of
  // allowed spell keys (null = non-caster / gating off). Built in addMember + refreshed
  // on level-up; the loadout itself comes from db (saved customization or curated default).
  _computeCastable(m) {
    try {
      if (!isCaster(m.cls)) { m.castableKeys = null; return; }
      if (isSpontaneous(m.cls)) m.castableKeys = new Set(db.getKnownSpells(m.playerId, m.cls) || []);
      else {
        m.castableKeys = new Set(Object.values(db.getPreparedSpells(m.playerId, m.cls) || {}).flat());
        // DOMAINS Phase C: a cleric's chosen domains' SPELLS ride the +1 domain
        // slot per level (slotsFor already counts it) — castable even when not
        // in the prepared list. Keys missing from the cleric kit (e.g. Divine
        // Power, not yet implemented) are harmless no-ops. Inquisitors get the
        // granted POWER only (PF1) — no domain spells.
        if (m.cls === 'cleric') {
          for (const dk of (db.getDomains(m.playerId, m.cls) || [])) {
            const d = DOMAINS[dk];
            if (d && d.spells) for (const sk of Object.values(d.spells)) m.castableKeys.add(sk);
          }
        }
        // THEURGE: Celeb has no per-day prep sheet in this engine — his whole
        // curated dual list is always "prepared" (slots still gate uses/level).
        if (m.cls === 'theurge') for (const a of theurgeKit()) if (a.slvl != null && a.slvl >= 1) m.castableKeys.add(a.key);
        // CHAR-GATED signature spells (Draymus's necromancy & Summon Undead) are their
        // character's DEFINING kit — always castable by them, not subject to the
        // prepared-list default (the char gate is still enforced by _charAllows at
        // cast). Mirrors the Celeb special-case above; a no-op for anyone with no
        // char-tagged spells in their kit.
        for (const a of (kitFor(m.cls).abilities || [])) {
          if (a.char && a.slvl != null && this._charAllows(a, m)) m.castableKeys.add(a.key);
        }
      }
    } catch (_) { m.castableKeys = null; }
  },
  _loadoutAllows(ab, m) {
    if (!ab || ab.slvl == null || ab.slvl < 1) return true;   // cantrips + class features: always castable
    if (!m || !m.castableKeys) return true;                   // non-caster / gating disabled
    return m.castableKeys.has(ab.key);
  },
  // ── THEURGE (Celeb) split-slot economy ──────────────────────────────────────
  // A theurge prepares HALF arcane + HALF divine per spell level. A spell tagged
  // side:'arcane' draws only the arcane half, 'divine' only the divine half, and
  // 'both' (on BOTH class lists) draws from whichever half he still has. Everyone
  // else uses the single shared pool (m.slots) — these helpers are transparent for
  // them, so non-theurge behaviour is byte-identical to before.
  _splitTheurgeSlots(m) {
    if (m.cls !== 'theurge' || !m.slots) { m.arcSlots = null; m.divSlots = null; return; }
    m.arcSlots = {}; m.divSlots = {};
    for (const L of Object.keys(m.slots)) { const n = m.slots[L] || 0; m.arcSlots[L] = Math.ceil(n / 2); m.divSlots[L] = Math.floor(n / 2); }   // odd extra → arcane
  },
  _slotAvail(m, ab, L) {
    if (m.cls !== 'theurge' || !m.arcSlots) return (((m.slots && m.slots[L]) || 0) > 0);
    const a = m.arcSlots[L] || 0, d = m.divSlots[L] || 0, side = ab && ab.side;
    if (side === 'arcane') return a > 0;
    if (side === 'divine') return d > 0;
    return (a + d) > 0;   // 'both' / untagged — either half
  },
  _spendSlot(m, ab, L) {
    if (m.cls !== 'theurge' || !m.arcSlots) { m.slots = m.slots || {}; m.slots[L] = Math.max(0, (m.slots[L] || 0) - 1); return; }
    const side = ab && ab.side, a = m.arcSlots[L] || 0, d = m.divSlots[L] || 0;
    if (side === 'arcane') m.arcSlots[L] = Math.max(0, a - 1);
    else if (side === 'divine') m.divSlots[L] = Math.max(0, d - 1);
    else if (d >= a && d > 0) m.divSlots[L] = d - 1;   // 'both' → spend the FULLER half to stay balanced
    else if (a > 0) m.arcSlots[L] = a - 1;
    else if (d > 0) m.divSlots[L] = d - 1;
    m.slots = m.slots || {}; m.slots[L] = Math.max(0, (m.slots[L] || 0) - 1);   // keep the shared total in sync (UI / serialization)
  },
  /** Wild Shape: toggle a druid form on/off. Re-casting the active form reverts;
   *  casting a different form swaps. Forms override the weapon (natural attacks),
   *  add a stat package to m.buffs, and may grant flight / DR / temp HP. */
  _abForm(m, ab) {
    const f = ab.form; if (!f) return;
    const sound = f.sound || pick(SND.flesh);
    m.buffs = m.buffs || { toHit: 0, dmg: 0, bonusDice: 0, acPen: 0, save: 0, ac: 0, deflect: 0 };
    if (m.form && m.form.key === f.key) {   // toggle OFF
      this._revertForm(m);
      this._note(`🔄 ${m.nickname} sheds ${f.label} and returns to their normal shape.`, sound);
      this._echoToTable(sound);
      return;
    }
    if (m.form) this._revertForm(m);        // switching forms — back the old one out first
    m._baseWeaponKey = m._baseWeaponKey || m.weaponKey;
    m.form = { key: f.key, label: f.label, glyph: f.glyph || '🐾', art: f.art || null, sizeSteps: f.sizeSteps || 0 };
    if (f.weapon) { m.weaponKey = f.weapon; m.weapon = weaponOf(m.gear, m.weaponKey); }
    const fb = { toHit: f.toHit || 0, dmg: f.dmg || 0, ac: f.ac || 0 };
    m.buffs.toHit += fb.toHit; m.buffs.dmg += fb.dmg; m.buffs.ac += fb.ac;
    m._formBuff = fb;
    if (f.dr)  { m._formDr = f.dr; m.dr = Math.max(m.dr || 0, f.dr); }
    if (f.fly) m.flying = true;
    const thp = (f.tempHpPerLevel || 0) * (m.level || 1) + (f.tempHp || 0);
    if (thp > 0) this._grantTempHp(m, thp);
    let atkStr = '';
    if (f.weapon) {
      const w = weaponOf(m.gear, m.weaponKey);
      const steps = (f.sizeSteps || 0) + (fighterFeats(m.cls, m.level, this._isRanged(m)).inw ? 1 : 0);
      const d = w.group === 'natural' && steps > 0 ? stepDamage(w.dmgCount, w.dmgDie, steps) : { count: w.dmgCount, die: w.dmgDie };
      atkStr = `${w.naturalAttacks} × ${d.count}d${d.die} attacks`;
    }
    const extra = [f.dr ? `DR ${f.dr}` : '', f.fly ? 'AIRBORNE' : '', atkStr].filter(Boolean).join(', ');
    this._note(`${ab.icon} ${m.nickname} shifts into ${f.label.toUpperCase()}!${extra ? ` (${extra})` : ''}`, sound);
    this._echoToTable(sound);
  },
  _revertForm(m) {
    if (!m.form) return;
    if (m._formBuff && m.buffs) { m.buffs.toHit -= m._formBuff.toHit; m.buffs.dmg -= m._formBuff.dmg; m.buffs.ac -= m._formBuff.ac; }
    m._formBuff = null;
    if (m._formDr) { m.dr = 0; m._formDr = 0; }   // form DR drops (re-cast Iron Skin if you want DR back)
    if (!m.innateFly) m.flying = false;            // hawk-form flight ends (but real WINGS stay — Strix)
    m.weaponKey = m._baseWeaponKey || m.weaponKey; m._baseWeaponKey = null; m.weapon = null;
    m.form = null;
    // (any temp HP the form granted lingers until the room resets — same as Rage/Bear's Endurance)
  },
  // The member's full action list: class kit + injected DOMAIN powers. Domain
  // entries append AFTER the kit so slot indices (the action payload contract
  // with the client) stay stable within a room; picks only change at the door.
  _abilitiesFor(m) {
    if (m.cls === 'theurge') return theurgeKit();   // THEURGE: full arcane+divine union, no class kit / no domain powers
    const kit = kitFor(m.cls).abilities;
    let list = (m._domPowers && m._domPowers.length) ? kit.concat(m._domPowers) : kit;
    if (m.cls === 'slayer') list = list.concat(STUDIED_TARGET);   // SLAYER: swift Studied Target mark (ACG)
    if (m.cls === 'cavalier') list = list.concat(CHALLENGE, GLORIOUS_CHALLENGE, BLAZE_OF_GLORY);   // CAVALIER: the Challenge oath (+level damage vs one foe); GLORIOUS_CHALLENGE + BLAZE_OF_GLORY (L15) are char-gated (Lord Gweyir / Order of the Flame) via _charAllows
    // MAGUS: name each Spell Strike by its DELIVERY — a ranged magus (Reese's bow)
    // fires it as an IMBUED SHOT; a melee magus channels it as a SPELL STRIKE. Copy
    // the ability so we never mutate the shared kit. (Same mechanic either way — the
    // touch spell rides the weapon/bow hit; see _abSpellstrike.)
    if (m.cls === 'magus') {
      const rng = this._isRanged(m);
      const pfx = rng ? 'Imbued Shot: ' : 'Spell Strike: ';
      list = list.map(a => a.effect === 'spellstrike' ? { ...a, name: pfx + a.name } : a);
      // A BOW magus (Reese) also gets the ranger's ARCHERY abilities — Rapid Shot +
      // Bullseye Shot — to match his archery feat-track (see fighterFeats magus-ranged).
      // Pulled from the ranger kit so they stay in sync; a melee magus skips them.
      if (rng) list = list.concat(kitFor('ranger').abilities.filter(a => a.key === 'rapidshot' || a.key === 'bullseye'));
    }
    return list;
  },
  // DOMAINS Phase B — re-read the picks (they may change between rooms), rebuild
  // the injected powers, stock the Liberation pool, set the passive auras.
  _domainSetup(m) {
    const lvl = m.level || 1;
    m.domains = maxDomainsFor(m.cls) > 0 ? (db.getDomains(m.playerId, m.cls) || []) : [];
    m._domPowers = []; m._domFoMRounds = 0; m.domainHealBoost = false; m.domainSunVuln = false;
    m._domStrike = 0; m._domSmite = 0; m._domFortune = false; m._domBleed = false; m._domWardRounds = 0;
    m._domAIBuffed = false;   // bot AI: one domain-buff action per room (see _botAbility 1d)
    for (const key of m.domains) {
      const g = DOMAINS[key] && DOMAINS[key].granted;
      if (!g) continue;
      if (g.kind === 'fom') m._domFoMRounds = lvl;               // Liberation: level rounds/room, auto-fires
      else if (g.kind === 'healboost') m.domainHealBoost = true; // Healing: passive — cures & channels +1/die
      else if (g.kind === 'sunvuln') m.domainSunVuln = true;     // Sun: passive — bonus damage vs undead
      else if (DOMAIN_POWERS[g.kind]) m._domPowers.push(DOMAIN_POWERS[g.kind]);
    }
  },
  // Per-room reset: refill the shared spell pool (full casters) + own-count
  // abilities, and clear sticky room buffs. Called each room and on join.
  _resetAbilities(m) {
    this._domainSetup(m);   // domains first — the uses loop below stocks their pools
    m.spellPool = isPoolClass(m.cls) ? spellSlots(m.level || 1) : 0;
    m.slots = slotsFor(m.cls, m.level || 1, m.castingMod);   // per-spell-level slots (base + casting-stat bonus + domain/school)
    this._splitTheurgeSlots(m);   // Celeb (theurge): fork each level's pool into HALF arcane / HALF divine
    if (m.cls === 'theurge') { const L = m.level || 1; m.synthUses = L >= 17 ? 3 : L >= 11 ? 2 : L >= 5 ? 1 : 0; }   // SPELL SYNTHESIS (Kobold Press): usable 1/2/3 times per room at L5/11/17
    if (m.cls === 'slayer') { m.studiedId = null; m.studiedN = 0; }   // SLAYER: Studied Target mark clears each room (fresh foes)
    if (m.cls === 'cavalier') { m.challengedId = null; m.challengeN = 0; m.gloriousN = 0; m.gloriousAC = 0; m._dauntedRoom = false; }   // CAVALIER: Challenge oath (and Order of the Flame's glorious-challenge stack + once-per-room Daunting Success) clear each room
    m.abilityUses = {};
    for (const ab of this._abilitiesFor(m)) if (ab.cost === 'room') m.abilityUses[ab.key] = roomUses(ab, m.level || 1, m);
    // Hero's Defiance — a paladin's once-per-room clutch self-rescue (auto-fired
    // from the turn loop when downed). HOME-RULE: paladins (and antipaladins) get
    // their spellcasting from LEVEL 1, not 4 — still the slowest progression in the
    // game, just without the dead first three levels.
    m.heroDefiance = (m.cls === 'paladin' || m.cls === 'antipaladin') ? 1 : 0;
    if (m.tempHp) { m.maxHp -= m.tempHp; if (m.hp > m.maxHp) m.hp = m.maxHp; m.tempHp = 0; }   // rage / Bear's Endurance temp HP fades
    m.buffs = null;          // rage / divine favor / inspire clear
    m.bane = null;           // inquisitor Bane declaration clears between rooms
    m.buffApplied = {};      // which sticky buffs are already active (no stacking)
    m._qcUsed = false;       // cleric Quicken Channel — one swift channel per room
    m._offDef = false;       // rogue Offensive Defense AC wears off between rooms
    // Power Attack / Deadly Aim are STANCES, not per-room buffs — silently re-assert
    // whichever the hero left on (free, no re-announce). A bot may still ease it off
    // mid-fight against a high-AC foe via _botStance.
    if (m.paOn)  this._applyPowerAttack(m, true, { silent: true });
    if (m.aimOn) this._applyDeadlyAim(m, true, { silent: true });
    m._fdAc = 0; if (m.fdOn) this._applyFightDefensively(m, true, { silent: true });
    m.smiteActive = false;
    m.hasted = 0; m.hasteFull = false; m._justHasted = false; m.stunned = 0;   // transient round effects clear each room
    m._lastAtkTarget = null;   // full-attack (same-target iterative) chain resets each room
    m.paralyzed = 0; m.heldDC = null; m.slowed = 0; m._slowTick = 0; m.sickened = 0; m.nauseated = 0;   // hold / slow / sicken / nausea wear off between rooms
    m.tauntedBy = null; m.grappled = false; m.grappledBy = null; m.grappleRounds = 0; m.prone = false; m.protectFire = false; if (!m.innateFly) m.flying = false; m.dr = 0; m.spiritWeapon = null; m.darkvision = false; m._bleeding = false;   // taunt / grapple / prone / fire ward / flight (real WINGS persist — Strix) / stoneskin / spiritual weapon / darkvision / bleeding clear between rooms
    if (m.form) { m.weaponKey = m._baseWeaponKey || m.weaponKey; m._baseWeaponKey = null; m.form = null; m.weapon = null; }   // Wild Shape drops between rooms (re-cast next room)
    m.invisible = false; m.greaterInvis = false; m.judgment = null;   // invisibility (incl. Greater) ends; judgement re-declared per encounter
    m.queuedAction = null;   // pre-loaded actions never carry into a new room (stale targets)
    m.infernalHeal = 0;   // Infernal Healing fast-healing ends between rooms
    // Magus per-room effects clear: mirror images, displacement, fire shield,
    // elemental body, true seeing, touch strikes, blur, blindness, melee-flight.
    m.images = 0; m.displaced = false; m.fireShield = null; m.elemBody = false; m.trueSeeing = false;
    m.touchStrike = 0; m.untargetable = false; m.blinded = 0; m.canHitFlyers = false;
    if (m.overlandFlight) { m.flying = true; m.canHitFlyers = true; }   // Overland Flight is RUN-long — re-assert flight + airborne reach
    if (m.ghost) { m.flying = true; m.canHitFlyers = true; }            // Vesorianna never lands — a ghost drifts over every room
    m.acPenRound = -1; m.acPenAmt = 0;
  },
  // Inspire Courage is a passive bard AURA — it costs the bard NO action and is
  // simply ALWAYS up while a bard is in the party. Fold its run-long +1/+1 into
  // every ally that doesn't already have it (guarded per-ally so multiple bards
  // or repeated rooms never stack it). Announced + played once per run, when the
  // song first goes up. Called at every room start and on join.
  // PF1 Inspire Courage progression: +1 at 1, +2 at 5, +3 at 11, +4 at 17
  // (Tobias 2026-07-04: "Elodie is a level 17 bard — her inspire courage
  // should be much more than +1"). One formula, used by the auto-aura AND
  // a manual cast.
  _inspireBonus(lvl) { return 1 + Math.floor(((lvl || 1) + 1) / 6); },
  _maintainBardSongs() {
    const bards = this.present().filter(m => m.cls === 'bard' && !m.dead);
    if (!bards.length) return;
    const ab = (kitFor('bard').abilities || []).find(a => a.key === 'inspire');
    if (!ab) return;
    // The guard `a.runBuffApplied.inspire` holds the NUMERIC bonus already folded
    // in (was a boolean) — morale bonuses don't stack, so the HIGHEST wins and we
    // only apply the delta. This lets a Battle Dancer's self-only double coexist
    // with a normal bard's party aura on the same members without double-dipping.
    let bestBonus = 0, bestBard = null, bestBD = false;
    for (const bard of bards) {
      const base = this._inspireBonus(bard.level);
      const bd = BATTLE_DANCERS.has((bard.playerId || '').toLowerCase());
      const bonus = bd ? base * 2 : base;                    // Battle Dance: doubled
      const targets = bd ? [bard] : this.present();          // Battle Dance: self only
      for (const a of targets) {
        if (a.dead) continue;
        a.runBuffApplied = a.runBuffApplied || {};
        const prev = a.runBuffApplied.inspire || 0;
        if (bonus <= prev) continue;                          // a stronger song already covers them
        const delta = bonus - prev;
        a.runBuffs = a.runBuffs || { toHit: 0, dmg: 0 };
        a.runBuffs.toHit += delta;
        a.runBuffs.dmg   += delta;
        a.runBuffApplied.inspire = bonus;
        if (bonus > bestBonus) { bestBonus = bonus; bestBard = bard; bestBD = bd; }
      }
      bard.runAbilityUses = bard.runAbilityUses || {};
      bard.runAbilityUses.inspire = 0;   // the song is up — no manual cast needed (won't be re-picked)
    }
    if (bestBard && !this._inspireAnnounced) {
      this._inspireAnnounced = true;
      if (bestBD) this._note(`${ab.icon} ${bestBard.nickname} whirls into a Dawnflower Dervish's BATTLE DANCE — HE alone burns at +${bestBonus} to hit and damage, all delve!`, ab.sound);
      else this._note(`${ab.icon} ${bestBard.nickname} keeps ${ab.name} up — the whole party fights at +${bestBonus} to hit and damage, all delve!`, ab.sound);
    }
  },
  // (_kitState moved to game/dungeon/serialize.js — Phase-2 seam 2)
  // Spell save DC + caster level for this member (level = 1 + gear).
  // PF1 spell save DC = 10 + SPELL LEVEL + casting-stat mod (+ Spell Focus).
  // Was 10 + CASTER level — a L17 Chain Lightning showed DC 37 (Tobias: "dc
  // should follow normal pf1 convention"); now 10 + 6 + mod ≈ 23. Metamagic
  // never raises it (ab.slvl is the BASE spell level, not the slot it rides
  // in). Class features with no slvl (Stunning Fist, gaze-likes) use PF1's
  // ability-DC shape instead: 10 + ½ level + casting mod.
  _spellDC(m, ab) {
    const base = (ab && ab.slvl >= 1) ? ab.slvl : Math.floor((m.level || 1) / 2);
    // THEURGE dual-stat DCs: an ability tagged dcStat ('int' arcane / 'wis' divine)
    // keys off THAT ability mod; everything else uses the class casting stat.
    const stat = (ab && ab.dcStat === 'best' && m.mods) ? Math.max(m.mods.int || 0, m.mods.wis || 0)   // dual-list spell — his better discipline
               : (ab && ab.dcStat && m.mods && m.mods[ab.dcStat] != null) ? m.mods[ab.dcStat]
               : (m.castingMod != null ? m.castingMod : CAST_MOD);
    return 10 + base + stat + (fighterFeats(m.cls, m.level, this._isRanged(m)).spellDC || 0) + (m._synthActive ? 4 : 0);   // Spell Synthesis: −4 to targets' saves == +4 to the DC
  },
  // ── PF1 SPELL RESISTANCE ──────────────────────────────────────────────────
  // A creature with SR shrugs off SPELLS unless the caster wins a caster-level
  // check: d20 + CL (+2 Spell Penetration, fighterFeats.spellPen) ≥ SR — rolled
  // once per target per cast (Tobias 2026-07-03: "follow pf1 conventions").
  // Only leveled SPELLS (ab.slvl) test SR; weapons, maneuvers and channel
  // energy (PF1: SR does not apply) pass through. A failed check still SPENDS
  // the slot and the action — the spell was cast, it just fails to bite.
  // `quiet` suppresses the per-target note (AoE handlers tally counts instead).
  _srBlocks(m, e, ab, quiet = false) {
    if (!e || !(e.sr > 0) || !ab || ab.slvl == null) return false;
    const pen = fighterFeats(m.cls, m.level, this._isRanged(m)).spellPen || 0;
    const bonus = (m.level || 1) + pen + (m._synthActive ? 4 : 0);   // Spell Synthesis: +4 caster level vs SR
    const roll = dRoll(20), total = roll + bonus;
    if (total >= e.sr) return false;   // punched through (PF1: caster-level checks have NO auto 20/1)
    if (!quiet) { this._note(`🛡️ ${e.glyph || ''} ${e.name}'s SPELL RESISTANCE turns ${ab.name} aside! [d20 ${roll}+${bonus} = ${total} vs SR ${e.sr}]`); }
    return true;
  },
  // Enemy spell vs a hero with racial SR (drow Olbryn: SR 6 + level). The
  // check is d20 + the foe's caster level vs the hero's SR. Supernatural
  // abilities (gazes, shouts, breath) never test SR — only their spells do.
  _srBlocksHero(e, m, label) {
    const sr = RACES.raceSR(m.race, m.level);
    if (!(sr > 0)) return false;
    const cl = this._enemyCL(e);
    const roll = dRoll(20), total = roll + cl;
    if (total >= sr) return false;   // (PF1: caster-level checks have NO auto 20/1)
    this._note(`🛡️ ${m.nickname}'s SPELL RESISTANCE turns ${label || 'the spell'} aside! [d20 ${roll}+${cl} = ${total} vs SR ${sr}]`);
    return true;
  },
  // Ranged-touch SPELL attack bonus. HOUSE RULE: casters aim their leveled touch
  // spells (Disintegrate, Scorching Ray, Shocking Grasp, elemental bolts) with their
  // SPELL stat, not Dex — so a wizard's ray lands as reliably as he casts. BAB +
  // casting-stat mod (NOT the legacy Dex-ish ABILITY_MOD). Cantrips already do this
  // (see _abCantrip); the magus's weapon-delivered Spellstrike keeps its weapon stat.
  _spellToHit(m) { return babFor(m.cls || 'fighter', m.level || 1) + (m.castingMod != null ? m.castingMod : CAST_MOD); },
  // ── METAMAGIC (PF1) ─────────────────────────────────────────────────────────
  // Two paths, mirroring the two spell systems:
  //   • SPONTANEOUS casters (sorcerer/bard/oracle/inquisitor) carry live TOGGLES in
  //     m.metamagic (set via the 'metamagic' action / UI). Toggling is gated on the
  //     caster owning the feat. A metamagic'd spontaneous spell is drawn from a slot
  //     +1/+2/+3/+4 HIGHER (Intensify/Empower/Maximize/Quicken) — see _slotLevelFor.
  //   • PREPARED casters (wizard/druid/magus) bake the flag onto a fixed spell entry
  //     (ab.empowered etc., like the magus); the higher slot cost is baked into the
  //     entry's minLevel, so prepared casts pay no runtime slot bump.
  //   • A bot may set a ONE-SHOT m._botMM for the cast it's about to make.
  // Stacking is allowed (PF1 RAW) — adjustments sum.
  _spontMM(m) {
    const t = (isSpontaneous(m.cls) && m.metamagic) ? m.metamagic : null;
    const b = m._botMM || null;
    if (!t && !b) return null;
    return { intensify: !!((t && t.intensify) || (b && b.intensify)), empower: !!((t && t.empower) || (b && b.empower)),
             maximize: !!((t && t.maximize) || (b && b.maximize)), quicken: !!((t && t.quicken) || (b && b.quicken)) };
  },
  // The metamagic that actually APPLIES to this cast = the spell's baked flags
  // (prepared) ∪ the spontaneous toggles / bot one-shot — but Empower/Maximize/
  // Intensify only do anything to a DICE (damage) spell, while Quicken applies to
  // any spell. So toggling Empower and then casting Haste wastes nothing (no boost,
  // no slot bump); Quicken + Haste still costs +4 and frees the action.
  _mmForCast(m, ab) {
    const s = this._spontMM(m) || {};
    const wantI = !!((ab && ab.intensified) || s.intensify), wantE = !!((ab && ab.empowered) || s.empower);
    const wantM = !!((ab && ab.maximized) || s.maximize), wantQ = !!((ab && ab.quickened) || s.quicken);
    const dice = !!(ab && ab.dice);
    return { intensify: wantI && dice && !!(ab && ab.dcap), empower: wantE && dice, maximize: wantM && dice, quicken: wantQ };
  },
  _mmAdjust(mm) { return mm ? ((mm.intensify ? 1 : 0) + (mm.empower ? 2 : 0) + (mm.maximize ? 3 : 0) + (mm.quicken ? 4 : 0)) : 0; },
  // Effective slot level for a SPONTANEOUS 'slot' cast = base spell level + the
  // adjustment for the toggles that actually APPLY to this spell (so a non-damage
  // spell isn't bumped by Empower). Prepared (room) casts never slot-bump.
  _slotLevelFor(m, ab) {
    if (ab.cost !== 'slot') return ab.slvl || 0;
    const s = this._spontMM(m); if (!s) return ab.slvl || 0;
    const dice = !!(ab && ab.dice);
    const adj = (s.intensify && dice && ab.dcap ? 1 : 0) + (s.empower && dice ? 2 : 0) + (s.maximize && dice ? 3 : 0) + (s.quicken ? 4 : 0);
    return (ab.slvl || 0) + adj;
  },
  // A spontaneous BOT may upgrade a damage spell with Empower/Maximize when it has the
  // feat AND a SURPLUS higher slot to spend (never cannibalises its single top slot).
  // Bots skip Quicken (action economy) and Intensify (marginal). Returns a one-shot
  // metamagic set for the cast, or null. Announces its choice.
  _botPickMetamagic(m, ab) {
    if (!ab || ab.cost !== 'slot' || !isSpontaneous(m.cls)) return null;
    if (!['bolt', 'aoe', 'touch', 'rays', 'disintegrate'].includes(ab.effect) || !ab.dice) return null;
    const ff = fighterFeats(m.cls, m.level, this._isRanged(m));
    const slots = m.slots || {}, base = ab.slvl || 1;
    const surplus = (adj) => { const L = base + adj; return L <= 9 && (slots[L] || 0) > 0 && ((slots[L] || 0) >= 2 || Object.keys(slots).some(k => +k > L && slots[k] > 0)); };
    let mm = null, word = '';
    if (ff.maximize && surplus(3))     { mm = { maximize: true }; word = 'MAXIMIZED'; }
    else if (ff.empower && surplus(2)) { mm = { empower: true };  word = 'EMPOWERED'; }
    if (mm) this._note(`✨ ${m.nickname} channels a ${word} ${ab.name}!`);
    return mm;
  },
  // Spell damage dice — INTENSIFIED SPELL raises a level-scaled spell's dice cap by +5
  // (PF1), so Shocking Grasp keeps growing past 5d6 and Fireball past 10d6.
  _spellDice(ab, m) {
    const mm = this._mmForCast(m, ab);
    const eab = (mm.intensify && ab.dcap && ab.dice) ? { ...ab, dcap: ab.dcap + 5 } : ab;
    // Staff of Lightning (Olbryn): +2 caster level to ELECTRICITY spells → +2 to the
    // level used for dice scaling, so Shocking Grasp / Lightning Bolt / Chain Lightning /
    // Jolt roll more dice and reach their caps two levels sooner.
    const clBonus = (m.lightningCL && ab.dtype === 'electricity') ? m.lightningCL : 0;
    return diceCount(eab, (m.level || 1) + clBonus);
  },
  // Roll a spell's damage dice with METAMAGIC applied. PF1 RAW stacking: MAXIMIZE sets
  // every die to max; EMPOWER adds +50% — and the two STACK (max the dice, then add
  // half of a fresh roll). Metamagic only reaches here if it's a baked spell flag or
  // an active spontaneous toggle (both gated on the caster's feat).
  _rollSpell(m, dice, die, ab) {
    const mm = this._mmForCast(m, ab);
    let dmg = mm.maximize ? dice * die : dRollN(dice, die);
    if (mm.empower) dmg += Math.floor((mm.maximize ? dRollN(dice, die) : dmg) * 0.5);
    return dmg;
  },
  _enemyTargets(payload, max) {
    let chosen = ((payload && payload.targetUids) || []).map(u => this.enemies.find(e => e.uid === u && e.hp > 0 && !(e.darkened > 0) && !e.summoned)).filter(Boolean);
    if (!chosen.length) chosen = this._targetableEnemies();   // Darkness-shrouded foes can't be hit
    return max ? chosen.slice(0, max) : chosen;
  },
  _oneEnemy(payload) {
    const t = this.enemies.find(x => x.uid === (payload && payload.targetUid) && x.hp > 0 && !(x.darkened > 0) && !x.summoned);   // never a friendly summon
    return t || this._targetableEnemies()[0] || null;
  },
  _saveVs(bonus, dc) { const r = dRoll(20); return { roll: r, total: r + bonus, saved: r === 20 ? true : r === 1 ? false : (r + bonus) >= dc }; },
  // Drops the running enemy HP total from ally attack lines (Josh: "Ague hit X for
  // 26, 128 of 154" was too much — he wants who hit whom for how much; he checks a
  // foe's HP with E). Keep only the ☠️ kill marker. Enemy hits on HEROES keep the
  // hero's HP (survival info) via their own line, not this helper.
  _afterEnemyHit(e) { return e.hp <= 0 ? ' ☠️' : ''; },
  // Effective melee AC of an enemy: sickened = +2 to be hit, prone = +4 to be hit.
  // Dimension Door / Teleport cast ON a melee ally (Tobias 2026-07-04): the
  // recipient blinks through folded space — (1) their NEXT turn is a guaranteed
  // full attack on ANY enemy they choose (_canReach always true while the
  // strike-window is up), and (2) NOBODY can target them until the CASTER's
  // next turn comes around (blinkedBy, cleared in _advanceToActor).
  _abTpStrike(m, ab, payload) {
    const pickedId = payload && (payload.allyUid || payload.targetUid);
    const explicit = pickedId ? this.livingParty().find(a => a.playerId === pickedId) : null;
    const melee = this.livingParty().filter(a => a.hp > 0 && !this._isRanged(a) && !(a._tpStrike > 0) && !a.blinkedBy);
    const a = explicit || melee.sort((x, y) => (y.level || 1) - (x.level || 1))[0];
    if (!a) return { ok: false, error: 'no melee ally to send — everyone is already placed (or ranged)' };
    a._tpStrike = 2;            // survives the cast round; active through their next attack
    a.blinkedBy = m.playerId;   // untouchable until the CASTER's next turn
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${a.playerId === m.playerId ? 'they blink' : `${a.nickname} blinks`} through folded space! Untouchable until ${m.nickname} acts again — and their next strike reaches ANY foe with a FULL attack.`, ab.sound);
    this._broadcast();
    return { ok: true };
  },
  // A flying creature holds the HIGH GROUND over the grounded party: +2 AC (hard
  // to reach a flyer from the floor). All heroes are grounded, so it always applies.
  // Effective AC for an attack. opts.touch → TOUCH AC (spells & firearms ignore
  // armor / natural armor). A FLAT-FOOTED enemy (hasn't acted yet) loses its Dex
  // (≈ −2). Situational mods (prone/sickened/slowed/flying) apply to every type.
  _enemyAC(e, opts = {}) {
    let base = opts.touch ? (e.touchAC != null ? e.touchAC : Math.max(10, e.ac - 5)) : e.ac;
    if (e.flatFooted) base = Math.max(10, base - 2);   // flat-footed: denied Dex
    // PF1 prone: −4 AC vs MELEE (easier to hit), but +4 AC vs RANGED (harder). Ranged =
    // an explicit ranged weapon OR a ranged-touch spell — every {touch} call except the
    // magus's MELEE touch, which passes {melee:true}. Sickened grants NO AC penalty in
    // PF1 (the old −2 here was really nauseated, now its own flag). Stunned = −2 AC.
    const rangedAtk = !!(opts.ranged || (opts.touch && !opts.melee));
    // GLORIOUS CHALLENGE (Order of the Flame): a cavalier on a kill-streak fights ever more
    // recklessly — −2 AC per consecutive glorious challenge this room (stacks; see _enemyMelee).
    const glory = e.gloriousChallenge ? 2 * (e.gloriousN || 0) : 0;
    return base - glory - (e.stunned > 0 ? 2 : 0) + (e.prone ? (rangedAtk ? 4 : -4) : 0) - (e.slowed > 0 ? 1 : 0) - (e.blinded > 0 ? 2 : 0) + (e.flying ? HIGH_GROUND_AC : 0) + (e.fdOn ? 2 : 0);   // Fight Defensively: +2 dodge AC
  },
  // Energy-resistance multiplier for a damage type (see RESIST_BY_KEY): 0 immune,
  // 0.5 resistant, 1.5 vulnerable, 1 (default) unchanged. Physical/untyped (no
  // dtype) is never modified.
  _resistMult(e, dtype) {
    if (!dtype || !e) return 1;
    if (e.resist && e.resist[dtype] != null) return e.resist[dtype];   // explicit entry wins (e.g. the fire-subtype Fire Skeleton is cold-VULNERABLE)
    // Standard PF1 undead immunities (user rule — vampires and ALL undead): cold
    // and poison simply bounce off, type-driven so every undead — including the
    // whole vampire court — is covered without per-monster bookkeeping.
    // Constructs share the poison immunity (no biology to poison).
    if (e.type === 'undead' && (dtype === 'cold' || dtype === 'poison')) return 0;
    if (e.type === 'construct' && dtype === 'poison') return 0;
    return 1;
  },
  // The damage actually dealt after resistance (vulnerable rounds up, resisted
  // keeps at least 1 unless fully immune).
  _resisted(e, dmg, dtype) {
    const mult = this._resistMult(e, dtype);
    if (mult === 1) return dmg;
    if (mult === 0) return 0;
    return Math.max(1, Math.round(dmg * mult));
  },
  // A short tag for the log when resistance changed the number.
  _resistTag(e, dtype) {
    const mult = this._resistMult(e, dtype);
    if (mult === 0) return ' ⛔immune';
    if (mult > 1) return ` 🔥×${mult}!`;
    if (mult < 1) return ' (resisted)';
    return '';
  },
  // Apply (resisted) damage of `dtype` to an enemy; any hit snaps a Fascinate.
  // Returns the damage actually dealt.
  _dmgE(e, dmg, dtype) {
    let dealt = this._resisted(e, dmg, dtype);
    // Boss pre-cast Protection from Fire: an absorption pool (12/CL) soaks fire
    // after resistance, until it burns out — mirror of the party's _fireSoak.
    if (dtype === 'fire' && e.fireWard > 0 && dealt > 0) {
      const soak = Math.min(e.fireWard, dealt);
      e.fireWard -= soak; dealt -= soak;
      this._note(`🔥🛡 ${e.name}'s fire ward absorbs ${soak}${e.fireWard <= 0 ? ' — the ward BURNS OUT!' : ''}.`);
    }
    e.hp -= dealt; if (e.fascinated) { e.fascinated = false; e.asleep = false; }   // a hit snaps Sleep/Fascinate
    if (e.charmed && dealt > 0 && e.hp > 0) { e.charmed = false; this._note(`💔 ${e.name}'s charm shatters — struck, it turns hostile again!`, null, { side: 'enemy' }); }   // attacking a charmed foe breaks the charm
    // NOTE: a Fire Skeleton does NOT explode when slain — kill it first and it's
    // DEFUSED. It only blows up if it survives to its own turn (see _detonate).
    return dealt;
  },
  // (_detonate moved to game/dungeon/enemyAI.js — Phase-2 seam 3)
  // Enemy save bonus. Monsters carry Fort + Reflex; Will is approximated.
  _enemySave(e, which) {
    const pray = (e.prayed || 0) + (e.sickened > 0 ? SICKENED_PENALTY : 0);   // Prayer −1 + sickened −2 (PF1): both drag every save
    if (which === 'fort') return (e.fort || 0) - pray;
    if (which === 'reflex') return (e.reflex || 0) - pray - (e.slowed > 0 ? 1 : 0);   // Slow: −1 Reflex (PF1)
    return Math.floor(((e.fort || 0) + (e.reflex || 0)) / 2) - pray;   // will (approx)
  },
  // A bare attack roll (to-hit only, no damage) using the member's weapon.
  // `extraDef` raises the foe's effective defense for this one roll (e.g. the PF1
  // trip-stability bonus for extra legs / larger size).
  _attackRoll(m, e, extraDef = 0) {
    const w = m.weapon || weaponOf(m.gear, m.weaponKey);
    const lvl = m.level || 1, cls = m.cls || 'fighter';
    const notProf = weaponProficient(cls, w) ? 0 : NON_PROFICIENT_PENALTY;   // PF1 proficiency — uniform, no AI exemption
    const toHit = babFor(cls, lvl) + ABILITY_MOD + (w.toHit || 0) + ((m.buffs && m.buffs.toHit) || 0) + this._hasteMod(m) + notProf - (m.sickened > 0 ? SICKENED_PENALTY : 0);
    const roll = dRoll(20), total = roll + toHit;
    return { hit: roll === 20 || (roll !== 1 && total >= this._enemyAC(e) + (extraDef || 0)), roll, total, toHit, weapon: w };
  },

  // ── Effects ──────────────────────────────────────────────────────────────
  // Ranged touch cantrip / single small bolt (Ray of Frost).
  // Public cantrip state for a caster (null for non-ray classes): the chosen
  // element + the choices, for the dungeon UI selector + blind announcement.
  _cantripState(m) {
    const at = kitFor(m.cls).atwill;
    if (!at || at.effect !== 'bolt') return null;
    const choices = this._cantripChoices(m, at);
    const current = choices.some(c => c.key === m.cantrip) ? m.cantrip : at.key;
    return { current, choices: choices.map(c => ({ key: c.key, name: c.name, icon: c.icon, dtype: c.dtype })) };
  },
  // The cantrips a caster may choose among: the universal three (cold/acid/elec)
  // + their class's own at-will if it's a different element (the flame oracle
  // keeps Produce Flame as a 4th).
  _cantripChoices(m, at) {
    at = at || (kitFor(m.cls).atwill);
    const base = CANTRIPS.slice();
    if (at && at.effect === 'bolt' && !base.some(c => c.key === at.key)) base.push(CANTRIP_BY_KEY[at.key] || at);
    return base;
  },
  // Which cantrip fires this swing. Humans use their chosen m.cantrip; bots
  // auto-pick the element the target is LEAST resistant to (prefers vulnerable,
  // never wastes it on an immune foe).
  _activeCantrip(m, targetUid, at) {
    at = at || kitFor(m.cls).atwill;
    const choices = this._cantripChoices(m, at);
    if (m.isBot) {
      const e = this.enemies.find(x => x.uid === targetUid && x.hp > 0) || this._targetableEnemies()[0];   // fall back to a REAL foe, never a summoned ally
      if (e) {
        let best = choices[0], bestMult = -1;
        for (const c of choices) { const mult = this._resistMult(e, c.dtype); if (mult > bestMult) { bestMult = mult; best = c; } }
        return best;
      }
    }
    return CANTRIP_BY_KEY[m.cantrip] || at || choices[0];
  },
  // Set a human caster's chosen at-will cantrip (the dungeon action 'cantrip').
  setCantrip(playerId, key) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };
    const choices = this._cantripChoices(m);
    const pick2 = choices.find(c => c.key === key);
    if (!pick2) return { ok: false, error: 'not a cantrip you can cast' };
    m.cantrip = key;
    this._broadcast();
    return { ok: true, cantrip: key };
  },
  // Toggle a metamagic on/off for a SPONTANEOUS caster (stacking allowed). Only a
  // metamagic the caster has the FEAT for can be toggled. Active metamagic re-levels
  // the next damaging spell to a higher slot (see _slotLevelFor) and boosts it.
  setMetamagic(playerId, key) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };
    if (!isSpontaneous(m.cls)) return { ok: false, error: 'prepared casters bake metamagic into prepared spells, not on the fly' };
    const ff = fighterFeats(m.cls, m.level, this._isRanged(m));
    if (!ff[key] || !['intensify', 'empower', 'maximize', 'quicken'].includes(key)) return { ok: false, error: 'you don\'t have that metamagic feat' };
    m.metamagic = m.metamagic || { intensify: false, empower: false, maximize: false, quicken: false };
    m.metamagic[key] = !m.metamagic[key];
    this._broadcast();
    return { ok: true, metamagic: m.metamagic };
  },
  // ── SPELLBOOK PICKER (spell loadouts, Phase D) ────────────────────────────
  // One action, two ops. No `toggle` → return the picker MODEL: the class's
  // implemented spell pool (char-gated, level-gated) grouped by spell level,
  // what's currently prepared/known, and the per-level slot caps. With
  // `toggle: key` → flip that spell in/out of the loadout (per-level cap
  // enforced for prepared casters) and return the updated model. Changes SAVE
  // immediately (per class, like class_xp) but land at the NEXT DOOR — the
  // castable set re-reads the DB in openDoor (PF1: you prepare between fights).
  loadout(playerId, payload = {}) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };
    if (!isCaster(m.cls)) return { ok: false, error: 'your class has no spells to prepare' };
    if (payload.toggle) {
      const r = this._loadoutToggle(m, String(payload.toggle));
      if (!r.ok) return r;
    }
    return { ok: true, ...this._loadoutModel(m) };
  },
  _loadoutModel(m) {
    const spont = isSpontaneous(m.cls);
    // THEURGE (Celeb): the loadout system has no 'theurge' KIT, so his pool is his
    // injected dual kit (theurgeKit) rather than kitSpells(cls) — otherwise the
    // Spellbook shows an empty list at every level.
    const src = (m.cls === 'theurge') ? theurgeKit().filter(ab => ab.slvl != null && ab.slvl >= 1) : loadouts.kitSpells(m.cls).filter(ab => this._charAllows(ab, m));
    const pool = src
      .filter(ab => (m.level || 1) >= (ab.minLevel || 1))   // only spells THIS character can cast at their level
      .map(ab => ({ key: ab.key, name: ab.name, icon: ab.icon || '✨', slvl: ab.slvl }));
    const caps = spont ? null : (slotsFor(m.cls, m.level || 1, m.castingMod) || {});
    return spont
      ? { spont, pool, caps, known: db.getKnownSpells(m.playerId, m.cls) || [] }
      : { spont, pool, caps, prepared: this._loadoutRebucket(m, db.getPreparedSpells(m.playerId, m.cls) || {}) };
  },
  // Self-heal a stored prepared map when a spell's slot LEVEL changes (e.g. the
  // metamagic-baked variants moving to their PF1-correct effective levels): any
  // key filed under the wrong level is re-bucketed to the spell's CURRENT slvl;
  // unknown keys drop; over-cap overflow trims. Keeps old saves from jamming a
  // level's cap with strays. (View-only here; a toggle persists the clean map.)
  _loadoutRebucket(m, prep) {
    const bySlvl = {};
    for (const s of (m.cls === 'theurge' ? theurgeKit() : loadouts.kitSpells(m.cls))) if (s.slvl != null) bySlvl[s.key] = String(s.slvl);
    const caps = slotsFor(m.cls, m.level || 1, m.castingMod) || {};
    const out = {};
    for (const arr of Object.values(prep || {})) {
      for (const key of (Array.isArray(arr) ? arr : [])) {
        const sl = bySlvl[key];
        if (!sl) continue;                                   // spell no longer exists
        out[sl] = out[sl] || [];
        if (!out[sl].includes(key)) out[sl].push(key);
      }
    }
    for (const sl of Object.keys(out)) {
      const cap = caps[sl] | 0;
      if (out[sl].length > cap) out[sl] = out[sl].slice(0, Math.max(0, cap));
    }
    return out;
  },
  _loadoutToggle(m, key) {
    const ab = loadouts.kitSpells(m.cls).find(s => s.key === key && this._charAllows(s, m));
    if (!ab) return { ok: false, error: 'not a spell your class can learn' };
    if ((m.level || 1) < (ab.minLevel || 1)) return { ok: false, error: `${ab.name} needs level ${ab.minLevel}` };
    if (isSpontaneous(m.cls)) {
      const known = db.getKnownSpells(m.playerId, m.cls) || [];
      const next = known.includes(key) ? known.filter(k => k !== key) : [...known, key];
      if (!next.length) return { ok: false, error: 'you must know at least one spell' };
      db.setKnownSpells(m.playerId, m.cls, next);
    } else {
      const prep = this._loadoutRebucket(m, db.getPreparedSpells(m.playerId, m.cls) || {});   // heal stray levels before toggling
      const sl = String(ab.slvl);
      const list = Array.isArray(prep[sl]) ? [...prep[sl]] : [];
      if (list.includes(key)) prep[sl] = list.filter(k => k !== key);
      else {
        const cap = ((slotsFor(m.cls, m.level || 1, m.castingMod) || {})[sl]) | 0;
        if (cap <= 0) return { ok: false, error: `you have no level-${sl} slots yet` };
        if (list.length >= cap) return { ok: false, error: `level ${sl} is full (${cap} slot${cap === 1 ? '' : 's'}) — unprepare something first` };
        prep[sl] = [...list, key];
      }
      db.setPreparedSpells(m.playerId, m.cls, prep);
    }
    return { ok: true };
  },
  // ── DOMAIN PICKER (Domains Phase C) ───────────────────────────────────────
  // One action, two ops (mirrors the Spellbook). No `toggle` → the picker MODEL:
  // all 8 domains (name/icon/blurb + granted power), the member's current picks
  // and the class cap. With `toggle: key` → flip that domain in/out (cap
  // enforced with a spoken-able reason). Changes SAVE immediately but land at
  // the NEXT DOOR (_domainSetup re-reads the DB each room) — "takes effect next
  // room". Dropping every pick reverts to the class default (a power always
  // exists — DOMAINS-DESIGN.md §5).
  domains(playerId, payload = {}) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };
    const max = maxDomainsFor(m.cls);
    if (!max) return { ok: false, error: 'your class has no domains' };
    if (payload.toggle) {
      const key = String(payload.toggle);
      if (!DOMAINS[key]) return { ok: false, error: 'no such domain' };
      const cur = db.getDomains(m.playerId, m.cls) || [];
      let next;
      if (cur.includes(key)) next = cur.filter(k => k !== key);
      else {
        if (cur.length >= max) return { ok: false, error: `a ${m.cls} may choose ${max} domain${max === 1 ? '' : 's'} — drop one first` };
        next = [...cur, key];
      }
      const r = db.setDomains(m.playerId, m.cls, next);
      if (!r.ok) return r;
    }
    return { ok: true, ...this._domainModel(m) };
  },
  // ── CLASS-PROGRESSION REFERENCE (Josh: "what does each level give me?") ───
  // A pure lookup: per-level gain summaries for the member's class from their
  // next level up to +9 (capped at 20), built from the same _levelGains the
  // level-up announcement uses so the two never drift. The blind X key speaks
  // these ("press 1 for level N+1…"); no state changes.
  progression(playerId) {
    const m = this.member(playerId);
    if (!m || m.left) return { ok: false, error: 'not in this run' };
    const cur = m.level || 1;
    const next = [];
    for (let L = cur + 1; L <= Math.min(20, cur + 9); L++) {
      const gains = this._levelGains(m, L - 1, L);
      next.push({ level: L, gains: gains.length ? gains.join(', ') : 'steady growth' });
    }
    return { ok: true, level: cur, cls: m.cls, next };
  },
  _domainModel(m) {
    const picks = db.getDomains(m.playerId, m.cls) || [];
    return {
      max: maxDomainsFor(m.cls),
      picks,
      domains: Object.values(DOMAINS).map(d => ({
        key: d.key, name: d.name, icon: d.icon, blurb: d.blurb,
        power: d.granted ? d.granted.name : null,
        limit: d.granted ? d.granted.limit : null,
        picked: picks.includes(d.key),
      })),
    };
  },
  // Improved at-will: casting stat to-hit AND to-damage (1d6 + casting mod), with
  // BAB-based iteratives (2nd ray at BAB 6, 3rd at 11, 4th at 16). Each ray is a
  // separate ranged touch; if the target drops, later rays carry to the next foe.
  _abCantrip(m, ab, e0) {
    const cm = m.castingMod || 0;
    const offs = (m.iteratives && m.iteratives.length) ? m.iteratives : [0];
    const sound = ab.sound || pick(SND.lightning);
    let target = e0, played = false;
    for (const off of offs) {
      if (!target || target.hp <= 0) target = this._targetableEnemies()[0];   // a real foe, not a summoned ally
      if (!target) break;
      const touchAC = this._enemyAC(target, { touch: true });
      const base = babFor(m.cls || 'fighter', m.level || 1) + cm + off;
      const roll = dRoll(20), total = roll + base;
      const snd = played ? null : sound; played = true;
      if (roll !== 20 && (roll === 1 || total < touchAC)) {
        this._note(`${ab.icon} ${m.nickname}'s ${ab.name} misses ${target.name}. [d20 ${roll} ${this._fmtBonus(base)} = ${total} vs touch ${touchAC}]`, snd);
        continue;
      }
      const raw = Math.max(1, dRollN(ab.dice || 1, ab.die || 6) + cm);
      const dmg = this._dmgE(target, raw, ab.dtype);
      this._note(`${ab.icon} ${m.nickname}'s ${ab.name} hits ${target.name} for ${dmg} ${ab.dtype || ''}${this._resistTag(target, ab.dtype)}.${this._afterEnemyHit(target)}`, snd);
      if (target.hp <= 0) this._tryBanter(m, 'down', { enemy: target.name });
      if (target.hp <= 0 && target.type === 'undead') this._radianceQuip(m, 'radiance_undead_down', { enemy: target.name });   // Vaughan's magus-craft unmakes the dead → Radiance erupts
    }
    this._echoToTable(sound);
  },
  _abBolt(m, ab, targetUid) {
    m.flatFooted = false;
    const e = this.enemies.find(x => x.uid === targetUid && x.hp > 0) || this.livingEnemies()[0];
    if (!e) return;
    if (ab.cantrip) return this._abCantrip(m, ab, e);   // improved model + iteratives
    const touchAC = this._enemyAC(e, { touch: true });   // ranged touch — ignores armor & natural armor
    const toHit = this._spellToHit(m);   // BAB + casting-stat mod (house rule: spell stat, not Dex)
    const roll = dRoll(20), total = roll + toHit;
    const sound = ab.sound || pick(SND.lightning);
    if (roll !== 20 && (roll === 1 || total < touchAC)) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} misses ${e.name}. [d20 ${roll} ${this._fmtBonus(toHit)} = ${total} vs touch ${touchAC}]`, sound); this._echoToTable(sound); return; }
    const raw = Math.max(1, this._rollSpell(m, this._spellDice(ab, m), ab.die || 3, ab) + (ab.flat || 0));
    const dmg = this._dmgE(e, raw, ab.dtype);
    this._note(`${ab.icon} ${m.nickname}'s ${ab.name} hits ${e.name} for ${dmg} ${ab.dtype || ''}${this._resistTag(e, ab.dtype)}.${this._afterEnemyHit(e)}`, sound);
    if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    if (e.hp <= 0 && e.type === 'undead') this._radianceQuip(m, 'radiance_undead_down', { enemy: e.name });   // undead unmade by Vaughan's bolt → Radiance erupts
    this._echoToTable(sound);
  },
  // Area damage with a save for half — Burning Hands / Holy Smite / Lightning
  // Bolt / Fireball. Hits up to ab.maxTargets foes (chosen or auto).
  _abAoe(m, ab, payload) {
    const dc = this._spellDC(m, ab), dice = this._spellDice(ab, m);
    let chosen;
    if (ab.randFoes || ab.randBase || ab.randN) {
      // Fireball-style: a RANDOM 1dN of the living enemies. Cone of Cold uses
      // randBase+randDie → 2+1d3 foes; Cloudkill uses randN d randDie → 3d4 foes.
      const living = this._targetableEnemies().slice();
      for (let i = living.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [living[i], living[j]] = [living[j], living[i]]; }
      let n;
      if (ab.randN) { n = 0; for (let i = 0; i < ab.randN; i++) n += dRoll(ab.randDie || 4); }
      else if (ab.randBase) n = (ab.randBase || 0) + dRoll(ab.randDie || 1);
      else n = dRoll(ab.randFoes);
      chosen = living.slice(0, n);
    } else {
      chosen = this._enemyTargets(payload, ab.maxTargets || 2);
    }
    const sound = (ab.sounds ? pick(ab.sounds) : ab.sound) || pick(SND.lightning), parts = [];   // Fireball/Lightning alternate from a pool
    const saveStat = ab.save || 'reflex';
    const saveLbl = saveStat === 'fort' ? 'Fort' : saveStat === 'will' ? 'Will' : 'Ref';
    // PF1e: the burst rolls its damage ONCE; every target saves against that same
    // number. Fail = full, save = half — or NONE if they have Evasion (a Reflex-
    // save area effect only). Resistance/vulnerability still applies per target.
    // Metamagic (Empower ×1.5 / Maximize) applies to the one shared roll.
    const full = this._rollSpell(m, dice, ab.die || 6, ab);
    // COUNTS-ONLY report (Josh): the save TYPE + DC + the rolled damage stated ONCE,
    // then a TALLY of how many failed / saved / were slain — NOT a per-enemy list.
    // Keeps mid-combat narration fast; the blind player inspects enemies (E) on their
    // own turn for exactly who's left and how hurt.
    let failN = 0, savedN = 0, slainN = 0, blindN = 0, srN = 0;
    for (const e of chosen) {
      if (this._srBlocks(m, e, ab, true)) { srN++; continue; }   // PF1 SR: checked per target, tallied (counts-only for Josh)
      const sv = this._saveVs(this._enemySave(e, saveStat), dc);
      const evaded = sv.saved && saveStat === 'reflex' && e.evasion;
      const raw = sv.saved ? (evaded ? 0 : Math.floor(full / 2)) : full;
      this._dmgE(e, raw, ab.dtype);
      // SUNBURST-style rider: a failed save also BLINDS (3 rounds, like Glitterdust).
      if (ab.blindRider && !sv.saved && e.hp > 0) { e.blinded = Math.max(e.blinded || 0, 3); blindN++; }
      if (sv.saved) savedN++; else failN++;
      if (e.hp <= 0) slainN++;
    }
    const tally = `${failN} hit${blindN ? ` (${blindN} BLINDED)` : ''}${savedN ? `, ${savedN} saved` : ''}${srN ? `, ${srN} spell-resisted` : ''}${slainN ? `, ${slainN} slain` : ''}`;
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${saveLbl} DC ${dc} (${full} ${ab.dtype || ''}): ${tally}.`, sound);
    this._echoToTable(sound);
  },
  // Disintegrate (PF1e): a ranged TOUCH ATTACK; on a hit, 2d6 per caster level
  // (cap 40d6 at CL20). Fortitude PARTIAL — a made save still takes 5d6 (NOT
  // half). Anything reduced to 0 HP is disintegrated into fine dust.
  _abDisintegrate(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    const sound = ab.sound || pick(SND.lightning);
    const touchAC = this._enemyAC(e, { touch: true });
    const toHit = this._spellToHit(m);   // BAB + casting-stat mod (house rule: spell stat, not Dex)
    const roll = dRoll(20), total = roll + toHit;
    if (roll !== 20 && (roll === 1 || total < touchAC)) {
      this._note(`${ab.icon} ${m.nickname}'s ${ab.name} ray streaks wide of ${e.name}. [touch d20 ${roll} ${this._fmtBonus(toHit)} = ${total} vs ${touchAC}]`, sound);
      this._echoToTable(sound); return;
    }
    const ndice = 2 * Math.min(20, m.level || 1);          // 2d6 / level, max 40d6
    const dc = this._spellDC(m, ab);
    const sv = this._saveVs(this._enemySave(e, ab.save || 'fort'), dc);
    const raw = sv.saved ? dRollN(5, 6) : dRollN(ndice, 6);   // Fort partial → only 5d6 on a save
    const dmg = this._dmgE(e, raw, ab.dtype);
    const dust = e.hp <= 0;
    this._note(`${ab.icon} ${m.nickname}'s ${ab.name} ray hits ${e.name} — Fort ${sv.total} vs ${dc}: ${sv.saved ? `partial ${dmg}` : `${dmg} force`}${this._resistTag(e, ab.dtype)}.${dust ? ` ☠️ ${e.name} crumbles to DUST!` : ''}`, sound);
    if (dust) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(sound);
  },
  // Magic Missile — auto-hit force darts (PF1: 1 dart, +1 per 2 caster levels,
  // max 5; each 1d4+1). Darts split across selected foes if more than one.
  _abMissile(m, ab, payload) {
    const darts = Math.min(5, 1 + Math.floor(((m.level || 1) - 1) / 2));   // L1:1 L3:2 L5:3 L7:4 L9:5
    let targets = this._enemyTargets(payload, darts);
    if (!targets.length) { const e = this._oneEnemy(payload); if (!e) return; targets = [e]; }
    const sound = ab.sound || pick(SND.lightning), parts = [];
    for (let i = 0; i < darts; i++) {
      const e = targets[i % targets.length];
      if (!e || e.hp <= 0) continue;
      // PF1: the Shield spell stops Magic Missiles cold (boss pre-cast ward).
      if (e.shieldUp) { parts.push(`${e.name} 🛡SHIELDED`); continue; }
      const d = dRoll(4) + 1;
      this._dmgE(e, d);
      parts.push(`${e.name} ${d}${e.hp <= 0 ? ' ☠️' : ''}`);
      if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    }
    this._note(`${ab.icon} ${m.nickname} looses ${darts} Magic Missile${darts > 1 ? 's' : ''} (auto-hit) — ${parts.join(', ')}.`, sound);
    this._echoToTable(sound);
  },
  // Ranged touch rays (Scorching Ray): 1+¼level rays of 4d6 each.
  _abRays(m, ab, payload) {
    let e = this._oneEnemy(payload); if (!e) return;
    // PF1e Scorching Ray: 1 ray, +1 per 4 caster levels past 3rd → 2 rays at CL7,
    // 3 at CL11. Each ray rolls to hit (4d6 fire) and is RESOLVED ONE AT A TIME — if
    // the target drops, the next ray redirects to another foe (you don't pre-commit
    // all rays to one target). When it SPLITS (2+), use the dramatic fire-combo sound.
    const rays = Math.max(1, Math.min(3, 1 + Math.floor(((m.level || 1) - 3) / 4)));
    const toHit = this._spellToHit(m);   // BAB + casting-stat mod (house rule: spell stat, not Dex)
    const sound = (rays >= 2 && ab.splitSound) ? ab.splitSound : (ab.sound || pick(SND.lightning));
    const tally = new Map();   // uid -> { name, dmg, hits }
    let anyHit = false;
    for (let i = 0; i < rays; i++) {
      if (!e || e.hp <= 0) e = this._targetableEnemies()[0];   // redirect to a fresh foe
      if (!e) break;                                            // nothing left to burn
      const rec = tally.get(e.uid) || { name: e.name, dmg: 0, hits: 0 };
      const roll = dRoll(20);
      if (roll === 20 || (roll !== 1 && roll + toHit >= this._enemyAC(e, { touch: true }))) {
        const d = this._dmgE(e, dRollN(ab.dice || 4, ab.die || 6), ab.dtype);
        rec.dmg += d; rec.hits++; anyHit = true;
        if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
      }
      tally.set(e.uid, rec);
    }
    if (!anyHit) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} (${rays} ray${rays > 1 ? 's' : ''}) all miss.`, sound); this._echoToTable(sound); return; }
    const parts = [...tally.values()].filter(r => r.hits).map(r => `${r.hits} ray${r.hits > 1 ? 's' : ''} → ${r.name} for ${r.dmg}`);
    const hitN = [...tally.values()].reduce((s, r) => s + r.hits, 0);
    const missed = rays - hitN;
    // State the number of rays FIRED (1 / 2 at CL7 / 3 at CL11), so a missed ray
    // doesn't make it look like fewer rays launched (Tobias: "only seeing 1 ray").
    this._note(`${ab.icon} ${m.nickname}'s ${ab.name} fires ${rays} ray${rays > 1 ? 's' : ''} — ${parts.join('; ')}${missed > 0 ? ` (${missed} miss${missed > 1 ? 'es' : ''})` : ''} ${ab.dtype || 'fire'}.`, sound);
    this._echoToTable(sound);
  },
  // Spellstrike: a weapon hit carrying bonus elemental dice (+ optional debuff).
  _abSpellstrike(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    const sound = MAGUS_SPELLSTRIKE_SFX[m.nickname] || ab.sound || r.sound;
    if (!r.hit) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} misses ${e.name}. ${this._atkStr(r)}`, sound); this._echoToTable(sound); return; }
    const dn = this._spellDice(ab, m);
    // MAXIMIZED → every die is its max (no roll). EMPOWERED → ×1.5. CAN-CRIT → the
    // spell damage rides the weapon's crit multiplier too (Maximized Shocking Grasp).
    let bonus = this._rollSpell(m, dn, ab.die || 6, ab);   // per-ability maximized/empowered + the magus's metamagic feats (Intensify raises dn via _spellDice)
    if (r.crit) bonus *= (m.weapon.critMult || 2);       // the channelled spell rides the weapon's crit (×2 scimitar, ×3, …) — EVERY spellstrike, not just the Max one
    const sbonus = this._resisted(e, bonus, ab.dtype);    // spell rider vs the foe's ELEMENTAL resistance (shock, cold, fire…)
    const total = r.damage + sbonus;                      // r.damage already passed PHYSICAL DR (weapon type vs the foe's DR)
    this._dmgE(e, total);
    let extra = '';
    if (r.crit) extra += ' — CRIT!';
    if (ab.debuff === 'sickened' && e.hp > 0) { e.sickened = SICKENED_ROUNDS; extra += ' — sickened (−2 to hit/dmg/saves)!'; }
    // Vampiric Touch: the negative energy heals the magus for what it drained.
    if (ab.lifesteal && bonus > 0) {
      const healed = Math.min(bonus, m.maxHp - m.hp);
      if (healed > 0) { m.hp += healed; extra += ` — drains ${healed} life (${m.hp}/${m.maxHp})!`; }
      else extra += ' — but is already at full vigor.';
    }
    // Forceful Strike — BULL RUSH: the foe is shoved, provoking a free attack from
    // one of the magus's melee allies (the closest stand-in for an attack of opportunity).
    if (ab.allyAOO && e.hp > 0) {
      const allies = this.livingParty().filter(a => a.playerId !== m.playerId && !a.flying);
      const ally = allies.length ? pick(allies) : null;
      if (ally) {
        ally.weapon = weaponOf(ally.gear, ally.weaponKey);
        const ra = this._swingVsAC(ally, this._enemyAC(e), e);
        if (ra.hit) { this._dmgE(e, ra.damage); extra += ` ${ally.nickname} seizes the opening — ${ra.damage}!`; if (e.hp <= 0) this._tryBanter(ally, 'down', { enemy: e.name }); }
        else extra += ` ${ally.nickname}'s free swing misses.`;
      }
    }
    this._note(`${ab.icon} ${m.nickname} ${ab.name}s ${e.name} for ${r.damage}${r.drTag || ''} weapon + ${sbonus}${this._resistTag(e, ab.dtype)} ${ab.dtype || ''} = ${total}.${extra}${this._afterEnemyHit(e)}`, sound);
    if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(sound);
  },
  // MONK Stunning Fist (free class feature, 1/room): a precise strike — a normal
  // attack, and on a hit the foe makes a Fort save (DC 10 + ½ level + WIS mod) or
  // is STUNNED, losing its next turn (e.loseTurn — same plumbing as Trip).
  _abStunningFist(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    const sound = ab.sound || r.sound;
    if (!r.hit) { this._note(`${ab.icon} ${m.nickname}'s Stunning Fist misses ${e.name}. ${this._atkStr(r)}`, sound); this._echoToTable(sound); return; }
    this._dmgE(e, r.damage);
    const dc = 10 + Math.floor((m.level || 1) / 2) + ((m.mods && m.mods.wis) || 0);
    let extra = '';
    if (e.hp > 0) {
      if (mindImmune(e)) extra = ` — but ${e.name} is immune to stunning (no living body).`;   // PF1: undead & constructs ignore the stun (the strike still hurt)
      else {
        const sv = this._saveVs(this._enemySave(e, 'fort'), dc);
        if (!sv.saved) { e.loseTurn = true; extra = ` — STUNNED [${sv.total} vs DC ${dc}], it loses its turn!`; }
        else extra = ` — it shakes off the stun [${sv.total} vs DC ${dc}].`;
      }
    }
    this._note(`${ab.icon} ${m.nickname}'s Stunning Fist ${r.crit ? 'CRITS' : 'strikes'} ${e.name} for ${r.damage}${r.drTag || ''}.${extra}${this._afterEnemyHit(e)}`, sound);
    if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(sound);
  },
  // ── MAGUS spell handlers ───────────────────────────────────────────────────
  // Glitterdust — a burst of clinging dust BLINDS a random 1d4 foes (Will negates).
  // Blinded = −4 to its own attacks, denied Dex (easier to hit, Sneak-Attackable).
  _abGlitterdust(m, ab, payload) {
    const sound = ab.sound;
    const dc = this._spellDC(m, ab);
    const n = (ab.randBase || 1) + dRoll(ab.randDie || 4);
    const pool = this._targetableEnemies().slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const targets = pool.slice(0, n);
    if (!targets.length) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} settles on no one.`, sound); this._echoToTable(sound); return; }
    const parts = []; let failN = 0, saveN = 0;
    for (const e of targets) {
      const sv = this._saveVs(this._enemySave(e, ab.save || 'will'), dc);
      if (!sv.saved) { e.blinded = BLIND_ROUNDS; failN++; parts.push(`${e.name} BLINDED [${sv.total} vs ${dc}]`); }
      else { saveN++; parts.push(`${e.name} resists [${sv.total} vs ${dc}]`); }
    }
    // 3+ targets → a succinct count (kind to chat AND the blind narrator); the
    // per-foe outcome lives on each enemy's condition chips. 1-2 keep detail.
    const detail = targets.length <= 2 ? parts.join('; ') : `${failN} BLINDED, ${saveN} resist [Will DC ${dc}]`;
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${targets.length} foe${targets.length === 1 ? '' : 's'} — ${detail}.`, sound);
    this._echoToTable(sound);
  },
  // Mirror Image — shimmering decoys soak incoming attacks (1d4 + 1 per 3 levels, max 8).
  _abMirrorImage(m, ab) {
    const lvl = m.level || 1;
    m.images = Math.min(8, dRoll(4) + Math.floor(lvl / 3));
    this._note(`${ab.icon} ${m.nickname} conjures ${m.images} mirror image${m.images > 1 ? 's' : ''} — decoys to soak incoming attacks!`, ab.sound);
    this._echoToTable(ab.sound);
  },
  // Blade Lash — strike one foe for weapon damage AND attempt to TRIP it (a combat-
  // maneuver check). On a success it is knocked prone and loses its turn.
  _abBladeLash(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    const sound = ab.sound || r.sound;
    if (!r.hit) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} cracks past ${e.name}. ${this._atkStr(r)}`, sound); this._echoToTable(sound); return; }
    this._dmgE(e, r.damage);
    let extra = '';
    if (e.hp > 0) {
      const blocked = this._tripBlocked(e);   // PF1: no legs / airborne / >1 size larger
      if (blocked) extra = ` — ${blocked}, cannot be tripped.`;
      else { const a = this._attackRoll(m, e, this._tripDefBonus(e)); if (a.hit) { e.prone = true; e.loseTurn = true; extra = ' — TRIPPED prone, it loses its turn!'; } else extra = ' — but it keeps its feet.'; }
    }
    this._note(`${ab.icon} ${m.nickname}'s ${ab.name} whips ${e.name} for ${r.damage}${r.drTag || ''}.${extra}${this._afterEnemyHit(e)}`, sound);
    if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(sound);
  },
  // Bladed Dash — strike one foe, then the magus blurs out of reach: UNTARGETABLE
  // (by attacks, buffs, or heals) until the start of their next turn.
  _abBladedDash(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    const sound = ab.sound || r.sound;
    if (r.hit) { this._dmgE(e, r.damage); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    m.untargetable = true;   // cleared at the start of the magus's next turn (see _advanceToActor)
    this._note(r.hit
      ? `${ab.icon} ${m.nickname} DASHES through ${e.name} for ${r.damage}${r.drTag || ''} and blurs out of reach — untargetable until next turn!${this._afterEnemyHit(e)}`
      : `${ab.icon} ${m.nickname} dashes past ${e.name} (a miss) and blurs out of reach — untargetable until next turn. ${this._atkStr(r)}`, sound);
    this._echoToTable(sound);
  },
  // Dimensional Blade — a FREE action: the magus's strikes resolve as TOUCH attacks
  // (ignore armor & natural armor) for 1 round (see touchStrike in _swingVsAC).
  _abDimBlade(m, ab) {
    m.touchStrike = 1;   // active this turn; cleared at the start of the next turn (1 round)
    this._note(`${ab.icon} ${m.nickname} phases the blade half a step sideways — strikes hit on TOUCH this round!`, ab.sound);
    this._echoToTable(ab.sound);
  },
  // Haste — the whole party blurs with speed. Each ally gets ONE extra attack on
  // their turn (see _hasteBonus), consumed when they act.
  _abHaste(m, ab) {
    const sound = ab.sounds ? pick(ab.sounds) : ab.sound;
    // PF1 duration: 1 round per caster level (each hasted turn grants an extra
    // attack; _hasteBonus decrements the counter). It always clears at room end
    // with the other buffs, so a long-enough fight is the only thing that ends it
    // early — which almost never happens (rooms rarely run past ~10 rounds).
    const turns = Math.max(1, m.level || 1);
    // The real HASTE spell (key 'haste') grants the extra attack PLUS +1 to hit,
    // +1 dodge AC, +1 Reflex (via _hasteMod). Blessing of Fervor (key
    // 'blessingoffervor') grants ONLY the extra attack — its PF1 haste choice.
    const full = ab.key === 'haste';
    for (const a of this.livingParty()) { a.hasted = turns; a.hasteFull = full; }
    // The caster spent THIS turn casting — their own extra attack waits until
    // their next turn (so the cast plays the Haste sound, not an immediate swing).
    m._justHasted = true;
    const extra = full ? ' (extra attack, +1 to hit, +1 AC, +1 Reflex)' : ' (an extra attack each turn)';
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — the party blurs with speed for ${turns} turn${turns > 1 ? 's' : ''}!${extra}`, sound);
    this._echoToTable(sound);
  },
  // Dispel Magic — strip the worst debuff off an afflicted ally (or self).
  // Dispel Magic auto-targets: the WORST-afflicted ally (strip their debuffs); or
  // if no ally is debuffed, strip the strongest BUFF off a foe (haste / combat
  // bonuses), if any.
  // PF1 dispel check: 1d20 + caster level vs DC 11 + the effect's caster level.
  // (The +10 CL cap is folded into the CL itself; Greater Dispel adds +4 — its
  // superior unweaving.) Returns { ok, roll, total, dc }. NOT auto-success on a 20
  // (caster-level checks aren't, in PF1).
  _dispelCheck(m, effectCL, greater) {
    const cl = (m.level || 1) + (greater ? 4 : 0);
    const roll = dRoll(20), total = roll + cl, dc = 11 + Math.max(1, effectCL | 0);
    return { ok: total >= dc, roll, total, dc, cl };
  },
  // A foe's effective caster level — what its OWN magic (pre-cast wards, self-buffs)
  // is dispelled against. Its CR stands in for its caster level; NO dungeon-depth
  // floor (that was the bug — depth, not the effect, inflated the DC).
  _enemyCL(e) { return Math.max(1, crToNum(e.cr) || (e.level || 0) || 1); },
  // The caster level of the WORST dispellable debuff on a hero — DC = 11 + this.
  // Each debuff is stamped with its source's CL when applied (e.g. paralyzedCL);
  // EFFECT_CL_FLOOR is the minimum (the spell's level), so the DC reflects the
  // EFFECT, not how deep you've delved.
  _dispellableCL(a) {
    let cl = 1;
    for (const k of Object.keys(EFFECT_CL_FLOOR)) {
      const active = (k === 'paralyzed') ? (a.paralyzed > 0 && a.heldDC != null) : (a[k] > 0);   // spell-held only — ghoul paralysis isn't a spell
      if (active) cl = Math.max(cl, a[k + 'CL'] || 0, EFFECT_CL_FLOOR[k]);
    }
    return cl;
  },
  // The foe most WORTH a dispel turn, or null (Tobias's economics, 2026-07-03):
  // SPELL-flight 4 (grounds an untouchable caster — "very valuable"), Invisibility
  // 3, Haste 3, big combat buffs 3, Mirror Image on a boss 2. Static AC wards
  // (Shield / Mage Armor / Shield of Faith / Stoneskin) score 0 — "not worth a
  // turn". Threshold 3. Innate wings (harpy, dragon) are NOT spell-flight.
  _dispelWorthyFoe() {
    const worth = (e) => ((e.flyCast || (e.precast && e.precast.includes('fly'))) && e.flying ? 4 : 0)
      + (e.invisible ? 3 : 0) + (e.hasted > 0 ? 3 : 0)
      + ((e.buffs && ((e.buffs.toHit || 0) + (e.buffs.dmg || 0)) >= 3) ? 3 : 0)
      + (e.images > 0 && e.boss ? 2 : 0);
    return this._targetableEnemies().filter(e => worth(e) >= 3).sort((a, b) => worth(b) - worth(a))[0] || null;
  },
  _abCleanse(m, ab, payload) {
    const sound = ab.sound;
    const FAIL_SOUND = '/audio/vine_boom.mp3';   // a FAILED dispel check (Foundry sting)
    // PF1 (Tobias 2026-07-03): Dispel Magic ends active SPELL effects ONLY —
    // hold/paralysis from a SPELL (heldDC set), Slow, magical blindness. A
    // monster's grapple, a stunning blow, sickness and lingering nausea are
    // PHYSICAL and stay (struggle, Grease, or heal them instead). REMOVE
    // PARALYSIS is the exception spell: it frees paralysis of ANY source —
    // even a ghoul's Su touch, which Dispel can't reach — plus Slow (PF1).
    const isRemovePara = ab.key === 'removeparalysis';
    const sev = isRemovePara
      ? (a) => (a.paralyzed > 0 ? 5 : 0) + (a.slowed > 0 ? 2 : 0)
      : (a) => ((a.paralyzed > 0 && a.heldDC != null) ? 5 : 0) + (a.slowed > 0 ? 2 : 0) + (a.blinded > 0 ? 2 : 0);
    // EXPLICIT pick (human party-card / enemy selection) — honor it. Invalid
    // explicit targets were already refused in _useAbility with a told-to-the-
    // caster reason, so a resolved pick here is a valid one. No pick → the
    // smart auto logic below (same as the AI).
    const pickId = payload && (payload.allyUid || payload.targetUid);
    const tAlly = pickId ? this.livingParty().find(a => a.playerId === (payload.allyUid || payload.targetUid)) : null;
    const tFoe = (pickId && !tAlly) ? this._targetableEnemies().find(e => e.uid === payload.targetUid) : null;
    const explicit = !!(tAlly || tFoe);
    // 1) Worst debuff on an ally. The hostile magic's caster level ≈ the toughest
    //    foe present (the likely source), floored by the dungeon depth.
    const hurt = (tAlly && sev(tAlly) > 0) ? tAlly
               : (!explicit ? this.livingParty().filter(a => sev(a) > 0).sort((x, y) => sev(y) - sev(x))[0] : null);
    if (hurt) {
      const effectCL = this._dispellableCL(hurt);   // DC = 11 + the EFFECT's caster level (PF1), not depth
      const dc = this._dispelCheck(m, effectCL, ab.greater);
      if (!dc.ok) {   // the weave HOLDS
        this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${hurt.nickname} — but the hostile magic HOLDS! [dispel d20 ${dc.roll} +${dc.cl} = ${dc.total} vs DC ${dc.dc}]`, FAIL_SOUND);
        this._echoToTable(FAIL_SOUND); return;
      }
      const cleared = [];
      // Spell effects only (see the ruling above) — grapple/stun/sickness/nausea stay.
      if (hurt.paralyzed > 0 && (isRemovePara || hurt.heldDC != null)) { hurt.paralyzed = 0; hurt.heldDC = null; cleared.push('paralysis'); }
      if (hurt.slowed > 0)    { hurt.slowed = 0; hurt._slowTick = 0; cleared.push('slow'); }
      if (!isRemovePara && hurt.blinded > 0) { hurt.blinded = 0; cleared.push('blindness'); }
      this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${hurt.nickname} — clears ${cleared.join(', ')}! [dispel ${dc.total} vs DC ${dc.dc}]`, sound);
      this._echoToTable(sound); return;
    }
    // 2) No ally debuff → strip the strongest buff off a foe (dispel check vs ITS CL).
    //    Boss PRE-CAST wards (mage armor / shield / stoneskin / fire ward / fly /
    //    shield of faith) count — plain Dispel peels ONE, Greater sweeps them all.
    const foeScore = (e) => (e.hasted > 0 ? 3 : 0) + ((e.precast && e.precast.length) ? e.precast.length * 2 : 0) + (e.invisible ? 3 : 0) + (e.images > 0 ? 2 : 0) + (e.flyCast ? 2 : 0) + (e.buffs ? ((e.buffs.toHit || 0) + (e.buffs.dmg || 0) + (e.buffs.ac || 0) + (e.buffs.bonusDice || 0)) : 0);
    const foe = (tFoe && foeScore(tFoe) > 0) ? tFoe
              : (!explicit ? this._targetableEnemies().filter(e => foeScore(e) > 0).sort((x, y) => foeScore(y) - foeScore(x))[0] : null);
    if (foe) {
      const dc = this._dispelCheck(m, this._enemyCL(foe), ab.greater);   // DC = 11 + the foe's caster level (PF1), not depth
      if (!dc.ok) {   // its enchantment HOLDS
        this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${foe.name} — but its enchantment HOLDS! [dispel d20 ${dc.roll} +${dc.cl} = ${dc.total} vs DC ${dc.dc}]`, FAIL_SOUND);
        this._echoToTable(FAIL_SOUND); return;
      }
      const stripped = [];
      // Revert one pre-cast ward (Greater: all of them), undoing its mechanics.
      const PRE_NAME = { magearmor: 'Mage Armor', shield: 'Shield', shieldoffaith: 'Shield of Faith', stoneskin: 'Stoneskin', protfire: 'fire ward', fly: 'Fly' };
      const revert = (key) => {
        if (key === 'magearmor') foe.ac -= 4;
        else if (key === 'shield') { foe.ac -= 4; foe.shieldUp = false; }
        else if (key === 'shieldoffaith') { foe.ac -= 3; foe.touchAC -= 3; }
        else if (key === 'stoneskin') { if (typeof foe.dr === 'number') foe.dr = 0; }
        else if (key === 'protfire') foe.fireWard = 0;
        else if (key === 'fly') { foe.flying = false; foe.prone = true; foe.loseTurn = true; }   // dispelled mid-air → CRASHES prone
        stripped.push(PRE_NAME[key] || key);
        if (key === 'fly') stripped[stripped.length - 1] += ' (it CRASHES to the ground!)';
      };
      // Peel ONE enchantment (plain Dispel) or ALL of them (Greater) — HIGH-VALUE
      // first (Tobias 2026-07-03: grounding spell-flight is worth the turn, a
      // static AC ward is not, so wards peel only when nothing better remains):
      // spell-Fly → Invisibility → Haste → Mirror Image → combat buffs → wards.
      const peelOne = () => {
        if (foe.flyCast)   { foe.flyCast = false; foe.flying = !!(foe.precast && foe.precast.includes('fly')); foe.prone = true; foe.loseTurn = true; stripped.push('Fly (it CRASHES to the ground!)'); return true; }
        if (foe.precast && foe.precast.includes('fly')) { foe.precast.splice(foe.precast.indexOf('fly'), 1); revert('fly'); return true; }
        if (foe.invisible) { foe.invisible = false; stripped.push('Invisibility'); return true; }
        if (foe.hasted > 0){ foe.hasted = 0; stripped.push('haste'); return true; }
        if (foe.images > 0){ foe.images = 0; stripped.push('Mirror Image'); return true; }
        if (foe.buffs)     { foe.buffs = null; stripped.push('combat buffs'); return true; }
        if (foe.precast && foe.precast.length) { revert(foe.precast.pop()); return true; }
        return false;
      };
      if (ab.greater) { while (peelOne()) { /* sweep everything */ } } else { peelOne(); }
      this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${foe.name} — strips its ${stripped.join(' & ')}! [dispel ${dc.total} vs DC ${dc.dc}]`, sound);
      this._echoToTable(sound); return;
    }
    // Nothing magical to dispel — NOT a failed check, so no fail sting.
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — but there's nothing to dispel.`, sound);
    this._echoToTable(sound);
  },
  // Invisibility — enemies can't target you until you attack (see _targetableParty
  // and the m.invisible=false clears in _playerAttack / offensive _useAbility).
  _abInvisible(m, ab, payload) {
    if (ab.greater) {
      // GREATER INVISIBILITY — stays up the whole fight, even when attacking. The
      // caster's CHOSEN ally wins; else best on a ROGUE ally (constant Sneak
      // Attack); else the caster.
      const party = this.livingParty();
      let target = this._pickedAlly(payload, { alive: true });
      if (!target) target = party.find(a => isSneakClass(a.cls) && a.playerId !== m.playerId) || m;
      target.invisible = true; target.greaterInvis = true;
      const who = (target.playerId === m.playerId) ? 'themselves' : target.nickname;
      const bonus = isSneakClass(target.cls) ? ' — and every strike a Sneak Attack!' : '';
      this._note(`${ab.icon} ${m.nickname} wraps ${who} in GREATER INVISIBILITY — unseen for the whole fight${bonus}`, ab.sound);
      this._echoToTable(ab.sound);
      return;
    }
    // The caster's CHOSEN ally (Josh: hide Vaughn, not always Nomkath), else the
    // MOST-HURT ally (least current HP) — not necessarily the caster.
    const target = this._pickedAlly(payload, { alive: true }) || this.livingParty().slice().sort((a, b) => a.hp - b.hp)[0] || m;
    target.invisible = true;
    const who = (target.playerId === m.playerId) ? 'themselves' : target.nickname;
    this._note(`${ab.icon} ${m.nickname} cloaks ${who} in INVISIBILITY — unseen until they strike.`, ab.sound);
    this._echoToTable(ab.sound);
  },
  // Mage Armor — a run-long +4 armor AC (see _acBonus). A free action; the flag is
  // NOT cleared on room reset, so it lasts the whole dungeon.
  _abMageArmor(m, ab) {
    m.mageArmor = true;
    this._note(`${ab.icon} ${m.nickname} weaves MAGE ARMOR — +4 armor AC for the rest of the dungeon.`, ab.sound);
    this._echoToTable(ab.sound);
  },
  // Overland Flight — a RUN-long flight (m.overlandFlight; re-asserted each room in
  // _resetAbilities). Grounded foes can't reach the caster; they can still cast.
  _abOverlandFlight(m, ab) {
    m.overlandFlight = true; m.flying = true;
    if (ab.canHitFlyers) m.canHitFlyers = true;   // magus version — can also melee airborne foes
    this._note(`${ab.icon} ${m.nickname} rises on OVERLAND FLIGHT — airborne for the rest of the dungeon (grounded foes can't reach them).`, ab.sound);
    this._echoToTable(ab.sound);
  },
  // Infernal Healing, Greater — fast healing 4 on the most-wounded ally (or a chosen
  // ally). Ticks at the start of that ally's turn (see _advanceToActor); lasts the room.
  _abInfernalHeal(m, ab, payload) {
    // The caster's CHOSEN ally wins; else the ally with the LEAST current HP right
    // now — INCLUDING downed/dying allies below 0 HP (the fast healing can knit
    // them back up). If everyone is at full HP, the caster takes it themselves.
    const wounded = this.party.filter(a => !a.left && !a.dead && a.hp < a.maxHp);
    const target = this._pickedAlly(payload) || (wounded.length ? wounded.slice().sort((a, b) => a.hp - b.hp)[0] : m);
    target.infernalHeal = ab.heal || 4;
    const who = (target.playerId === m.playerId) ? 'themselves' : target.nickname;
    this._note(`${ab.icon} ${m.nickname} anoints ${who} with infernal ichor — fast healing ${target.infernalHeal} HP/turn for the rest of the room.`, ab.sound);
    this._echoToTable(ab.sound);
  },
  // Black Tentacles — a room hazard: each round (and on the cast) it grapples a
  // random 1d4+1 ungrappled foes (PF1 grapple: CMB vs CMD). Grappled = helpless,
  // losing turns until they break free (see _enemyAct). Lasts the room.
  _abBlackTentacles(m, ab) {
    const cl = m.level || 1;
    this.blackTentacles = { cmb: cl + 5, caster: m.playerId, sound: ab.sound };   // CMB ≈ caster level + Str/size
    this._note(`${ab.icon} ${m.nickname} conjures BLACK TENTACLES — the floor erupts with grasping limbs!`, ab.sound);
    this._echoToTable(ab.sound);
    this._blackTentaclesTick();   // grab immediately on the cast
  },
  _blackTentaclesTick() {
    const bt = this.blackTentacles; if (!bt) return;
    const free = this._targetableEnemies().filter(e => !e.grappled && e.hp > 0);
    if (!free.length) return;
    for (let i = free.length - 1; i > 0; i--) { const j = dRoll(i + 1) - 1; [free[i], free[j]] = [free[j], free[i]]; }
    const grabbed = free.slice(0, dRoll(4) + 1);   // 1d4+1 foes
    let seized = 0, resisted = 0;                   // COUNTS-ONLY report (Josh: consistent AoE narration)
    for (const e of grabbed) {
      const ecmd = 10 + (e.toHit || 0) + 2;                    // foe's CMD (rough)
      const roll = dRoll(20), tot = roll + bt.cmb;
      if (roll === 20 || tot >= ecmd) { e.grappled = true; e.grappledBy = 'tentacles'; e.grappleRounds = 99; seized++; }
      else resisted++;
    }
    if (seized || resisted) { this._note(`🦑 The black tentacles lash out — ${seized} seized${resisted ? `, ${resisted} resisted` : ''}.`, bt.sound); this._broadcast(); }
  },
  // Suffocation — single living target (not undead/constructs): Fort save or DIE.
  // A made save (or a boss too tough to fell outright) still takes heavy damage.
  _abSaveDie(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    const sound = ab.sound || pick(SND.lightning);
    // Only living, breathing creatures can be suffocated — undead, constructs,
    // oozes and elementals are immune (by type, with a name fallback).
    const immune = e.type === 'undead' || e.type === 'construct'
      || /golem|skelet|zombie|wraith|ghost|lich|vampire|wight|ghoul|ghast|shadow|ooze|elemental|construct|undead/i.test(e.name || '');
    if (immune) {
      this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${e.name} — but it doesn't breathe. No effect.`, sound);
      this._echoToTable(sound); return;
    }
    const dc = this._spellDC(m, ab);
    const sv = this._saveVs(this._enemySave(e, ab.save || 'fort'), dc);
    if (!sv.saved && !e.boss) {
      this._dmgE(e, e.hp + 20, ab.dtype);   // lethal
      this._note(`${ab.icon} ${m.nickname} SUFFOCATES ${e.name}! [Fort ${sv.total} vs ${dc}] — it collapses, airless and lifeless. ☠️`, sound);
    } else {
      const frac = !sv.saved ? 0.5 : 0.25;   // boss-failed = half max HP; made save = a quarter
      const dmg = this._dmgE(e, Math.max(6, Math.floor((e.maxHp || 20) * frac)), ab.dtype);
      this._note(`${ab.icon} ${m.nickname}'s ${ab.name} chokes ${e.name} — ${!sv.saved ? 'too mighty to fell outright' : 'it claws in a breath'}: ${dmg} damage. [Fort ${sv.total} vs ${dc}]${e.hp <= 0 ? ' ☠️' : ''}`, sound);
    }
    this._echoToTable(sound);
  },
  // Judgement (inquisitor): set the one active judgement. Switching is a FREE
  // action (see _useAbility returning freeAction). destruction=+dmg, protection=
  // +AC, healing=regen each of your turns. Applied in combat math + _advanceToActor.
  _abJudgment(m, ab) {
    m.judgment = ab.judgmentType;
    const what = { destruction: '⚔️ Destruction (+damage)', protection: '🛡️ Protection (+AC)', healing: '💗 Healing (regen)' }[ab.judgmentType] || ab.judgmentType;
    this._note(`${ab.icon} ${m.nickname} pronounces Judgement — ${what}.`, ab.sound);
    this._echoToTable(ab.sound);
  },
  // Bane (inquisitor): declare a creature TYPE (a FREE action — see _useAbility
  // returning freeAction; 1 use per 5 levels per room). The bane bonus (+2 to hit,
  // +2d6+2 damage) then applies ONLY to foes of that type, until you re-declare.
  // The bonus math lives in _playerAttack (baneOn). A human picks by selecting a
  // foe (the client sends its type as payload.baneType); bots auto-pick.
  _abBane(m, ab, payload) {
    const type = (payload && payload.baneType) || this._autoBaneType();
    if (!type) { this._note(`🗡️ ${m.nickname} finds no foe worth naming for Bane.`); return; }
    m.bane = { type };
    this._note(`${ab.icon} ${m.nickname} pronounces BANE against ${titleCase(type)} — +2 to hit and +2d6+2 damage vs ${titleCase(type)} this room.`, ab.sound);
    this._echoToTable(ab.sound);
  },
  // Auto-pick a Bane type from the foes on the field: the most COMMON type present,
  // breaking ties toward the TOUGHEST foe's type.
  _autoBaneType() {
    const foes = this.livingEnemies();
    if (!foes.length) return null;
    const counts = new Map();
    for (const e of foes) if (e.type) counts.set(e.type, (counts.get(e.type) || 0) + 1);
    if (!counts.size) return null;
    let best = null, bestN = -1;
    for (const [t, n] of counts) if (n > bestN) { best = t; bestN = n; }
    const toughest = foes.slice().sort((a, b) => b.maxHp - a.maxHp)[0];   // tie-break → toughest foe's type
    if (toughest && toughest.type && counts.get(toughest.type) === bestN) best = toughest.type;
    return best;
  },
  // If `m` is hasted, spend it on one bonus attack against a living foe. Called
  // right after the member's normal action resolves (human + bot paths).
  _hasteBonus(m) {
    if (!m) return;
    // This runs at the very end of the member's turn, so it's also where the
    // taunt compulsion is spent — but the free Haste swing still honors it.
    const forced = this._forcedFoe(m);
    m.tauntedBy = null;
    if (!(m.hasted > 0) || m.hp <= 0 || m.left || m.dead) return;
    if (m._justHasted) { m._justHasted = false; return; }   // cast Haste this turn → bonus starts next turn
    m.hasted -= 1;   // spend one of the hasted turns
    const foes = this._targetableEnemies();   // the bonus swing hits a REAL foe, never a summoned ally
    if (!foes.length) return;
    const tgt = (forced && foes.includes(forced)) ? forced : (this._preferredFoe(m, foes) || foes[0]);
    this._note(`💨 ${m.nickname} blurs with Haste — an extra strike!`);
    this._playerAttack(m, tgt.uid, true);   // quiet: don't clobber the turn's main-action sound
  },
  // Breath of Life (revive a DYING ally + big heal) / Raise Dead + Resurrection
  // (bring a SLAIN ally back into the run). High-level cleric prayers.
  _abRevive(m, ab, payload) {
    const lvl = m.level || 1;
    const sound = ab.sound;
    const healBig = () => Math.max(1, dRollN(ab.reviveDice || 5, 8) + Math.min(ab.reviveCap || lvl, lvl));
    if (ab.raiseDead) {
      // Raise Dead / Resurrection — cast OUT of combat (end of room). Bring a SLAIN ally
      // back: Raise Dead at 1 HP (the lost level STAYS lost); Resurrection at FULL HP
      // (the lost level is RESTORED — we simply clear the still-pending penalty).
      const dead = this.party.find(a => a.dead && !a.left);
      // Reincarnate (druid) — the soul comes back in a NEW body: the fallen hero
      // is replaced by a random hero from the BENCH (not at the poker table, not
      // in the dungeon), arriving at full health as themselves. Only BOT heroes
      // swap identities (a human's run stays theirs — for them it falls through
      // to a plain raise). No bench available → plain raise too.
      if (ab.reincarnate && dead && dead.isBot) {
        const pool = (typeof this._recruitableFn === 'function' && this._recruitableFn()) || [];
        if (pool.length) {
          const choice = pool[Math.floor(Math.random() * pool.length)];
          const rec = db.getPlayer(choice.playerId)
                   || { player_id: choice.playerId, nickname: choice.nickname, class: choice.cls, avatar_id: choice.avatarId };
          dead.left = true;   // the old body is gone for good — the soul moved house
          this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${dead.nickname}'s soul takes root in a new body…`, sound);
          const nm = this.addMember(rec, true);
          this._note(`🌱 …and rises as ${nm.nickname} the ${nm.cls} (Lv ${nm.level}), whole and hale!`);
          this._echoToTable(sound); this._broadcast(); return;
        }
      }
      if (dead) {
        dead.dead = false; dead.downed = false; dead.left = false;
        dead.flatFooted = true; dead.paralyzed = 0; dead.stunned = 0;
        if (ab.full) {
          dead.hp = dead.maxHp;
          dead._deathPending = false;   // Resurrection restores the lost level
          this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${dead.nickname} is RESURRECTED at full health, whole again (level restored)!`, sound);
        } else {
          dead.hp = 1;
          this._applyDeathPenalty(dead);   // Raise Dead does NOT restore the lost level
          this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${dead.nickname} is dragged back into the run at 1 HP.`, sound);
        }
        if (this.status === 'combat' && !this.turnOrder.some(t => t.kind === 'party' && t.id === dead.playerId)) {
          this.turnOrder.push({ kind: 'party', id: dead.playerId, init: dRoll(20) });
        }
        this._echoToTable(sound); this._broadcast(); return;
      }
      // No corpse to raise → fall through to a big heal.
    } else {
      // Breath of Life — snatch a DYING (downed) OR freshly-SLAIN ally back (castable IN
      // combat). Catching them in time PREVENTS the lost level. The caster's CHOSEN
      // ally (if they picked a downed/slain one) wins; else prefer the dying (cheaper
      // to save) before the dead.
      const picked = this._pickedAlly(payload);
      const target = (picked && (picked.downed || picked.dead) ? picked : null)
                  || this.party.find(a => !a.left && !a.dead && a.downed)
                  || this.party.find(a => !a.left && a.dead);
      if (target) {
        const wasDead = target.dead;
        target.dead = false; target.downed = false;
        target.hp = Math.min(target.maxHp, Math.max(1, healBig()));
        target._deathPending = false;   // revived in time → no level lost
        if (wasDead) {
          target.flatFooted = true; target.paralyzed = 0; target.stunned = 0;
          if (this.status === 'combat' && !this.turnOrder.some(t => t.kind === 'party' && t.id === target.playerId)) {
            this.turnOrder.push({ kind: 'party', id: target.playerId, init: dRoll(20) });
          }
        }
        this._note(`${ab.icon} ${m.nickname} breathes life into ${target.nickname} — back ${wasDead ? 'from the brink of death ' : ''}up at ${target.hp}/${target.maxHp} HP!`, sound);
        this._echoToTable(sound); this._broadcast(); return;
      }
    }
    // Nobody to revive → a big heal on the most-hurt living ally.
    const allies = this.livingParty();
    const target = allies.slice().sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0] || m;
    const h = healBig(); target.hp = Math.min(target.maxHp, target.hp + h);
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${target.nickname} heals ${h} (${target.hp}/${target.maxHp}).`, sound);
    this._echoToTable(sound);
  },
  // Mass Suggestion (bard 6th) — up to 3 foes, Will save or CHARMED (the existing
  // charm state: they stop attacking the party; a hit snaps each out).
  _abMassCharm(m, ab, payload) {
    const chosen = this._enemyTargets(payload, ab.maxTargets || 3).filter(e => e.hp > 0 && !mindImmune(e) && !e.charmed && !(e.dominated > 0));
    if (!chosen.length) { this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — but there are no minds there to sway.`); this._echoToTable(); return; }
    const dc = this._spellDC(m, ab);
    let got = 0, held = 0;
    for (const e of chosen) {
      const sv = this._saveVs(this._enemySave(e, 'will'), dc);
      if (!sv.saved) { e.charmed = true; e.taunted = null; got++; } else held++;
    }
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} (Will DC ${dc}) — ${got} charmed${held ? `, ${held} resisted` : ''}.`, ab.sound);
    this._echoToTable(ab.sound);
  },
  // Waves of Exhaustion (7th, necromancy) — NO SAVE: living foes in the wave are
  // EXHAUSTED, modelled as the slowed/staggered condition (one action a turn,
  // −1 to hit, −1 AC). Undead and constructs (no living body) are untouched.
  _abExhaust(m, ab, payload) {
    const chosen = this._enemyTargets(payload, ab.maxTargets || 6).filter(e => e.hp > 0);
    const living = chosen.filter(e => !(e.type === 'undead' || e.type === 'construct'));
    if (!living.length) { this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — nothing there lives to tire.`); this._echoToTable(); return; }
    const dur = Math.max(3, Math.min(8, Math.floor((m.level || 1) / 2)));
    for (const e of living) e.slowed = Math.max(e.slowed || 0, dur);
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — a wave of crushing fatigue, NO save: ${living.length} foe${living.length === 1 ? '' : 's'} EXHAUSTED (one action a turn, ${dur} rounds).`, ab.sound);
    this._echoToTable(ab.sound);
  },
  // Prismatic Spray (7th) — every foe in the fan takes a RANDOM ray: one of the
  // four elements for level d6 (Reflex half), or on a violet ray (1-in-8) a
  // Fortitude save or be UNMADE outright (no effect on the unliving).
  _abPrismatic(m, ab, payload) {
    const chosen = this._enemyTargets(payload, ab.maxTargets || 6).filter(e => e.hp > 0);
    if (!chosen.length) return;
    const dc = this._spellDC(m, ab), dice = this._spellDice(ab, m);
    let failN = 0, savedN = 0, slainN = 0;
    const violets = [];
    for (const e of chosen) {
      if (dRoll(8) === 8 && !(e.type === 'undead' || e.type === 'construct')) {
        const sv = this._saveVs(this._enemySave(e, 'fort'), dc);
        if (!sv.saved) { this._dmgE(e, e.hp + 10, 'force'); violets.push(e.name); slainN++; }
        else savedN++;
        continue;
      }
      const dtype = pick(['fire', 'cold', 'electricity', 'acid']);
      const sv = this._saveVs(this._enemySave(e, 'reflex'), dc);
      const full = this._rollSpell(m, dice, ab.die || 6, ab);
      this._dmgE(e, sv.saved ? Math.floor(full / 2) : full, dtype);
      if (sv.saved) savedN++; else failN++;
      if (e.hp <= 0) slainN++;
    }
    const violetNote = violets.length ? ` — the VIOLET RAY unmakes ${violets.join(' & ')}!` : '';
    this._note(`${ab.icon} ${m.nickname} fans a PRISMATIC SPRAY (DC ${dc}) — ${failN} blasted${savedN ? `, ${savedN} saved` : ''}${slainN ? `, ${slainN} slain` : ''}.${violetNote}`, ab.sound);
    this._echoToTable(ab.sound);
  },
  // Dominate Person / Monster — a Will save or the foe FIGHTS FOR THE PARTY:
  // each of its turns it attacks its own allies; a fresh Will save each turn can
  // shake the hold, and it breaks if the caster drops. (Dominate Phase B slides
  // the victim's card across the battlefield; for now the 💫 narration carries it.)
  _abDominate(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    if (mindImmune(e)) { this._note(`${ab.icon} ${e.name} is immune to ${ab.name} — undead and constructs have no mind to command.`); this._echoToTable(); return; }
    if (e.dominated > 0) { this._note(`${ab.icon} ${e.name} is already dominated.`); return; }
    const dc = this._spellDC(m, ab);
    const sv = this._saveVs(this._enemySave(e, 'will'), dc);
    if (sv.saved) {
      this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${e.name} — its will holds. [Will ${sv.total} vs DC ${dc}]`, ab.sound);
    } else {
      e.dominated = Math.max(2, Math.floor((m.level || 1) / 2));
      e.dominatedBy = m.playerId; e.dominateDC = dc;
      e.charmed = false; e.taunted = null;   // domination supersedes lesser sway
      this._note(`${ab.icon} 💫 ${m.nickname} casts ${ab.name} — ${e.name}'s eyes glaze; it is DOMINATED and turns on its own! [Will ${sv.total} vs DC ${dc}]`, ab.sound);
    }
    this._echoToTable(ab.sound);
  },
  // FORCE PUSH (Jason's Force Pike, à la Dota's Force Staff): Jason forgoes his own
  // strike to SHOVE a foe — every melee ally whose weapon is OUT (they melee'd within
  // the last round) seizes the opening for ONE free attack against it. Reuses the
  // magus Bull-Rush allyAOO pattern, but for ALL qualifying melee allies at once.
  _abForcePush(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    this._note(`${ab.icon} 🌬️ ${m.nickname} FORCE-PUSHES ${e.name} with the Force Pike — into the party's reach!`, ab.sound);
    const allies = this.livingParty().filter(a => a.playerId !== m.playerId && a.hp > 0 && !a.left
      && !this._isRanged(a) && (this.round - (a._lastMeleeRound == null ? -99 : a._lastMeleeRound)) <= 1);
    if (!allies.length) { this._note(`…but no melee ally has a weapon out to capitalize.`); this._echoToTable(ab.sound); return; }
    for (const ally of allies) {
      if (e.hp <= 0) break;
      ally.weapon = weaponOf(ally.gear, ally.weaponKey);
      const r = this._swingVsAC(ally, this._enemyAC(e), e);
      if (r.hit) { this._dmgE(e, r.damage); this._note(`⚔️ ${ally.nickname} seizes the opening on ${e.name} — ${r.damage}${r.drTag || ''}!${e.hp <= 0 ? ' ☠️ Slain!' : ''}`, r.sound); if (e.hp <= 0) this._tryBanter(ally, 'down', { enemy: e.name }); }
      else this._note(`⚔️ ${ally.nickname}'s free swing at ${e.name} misses. ${this._atkStr(r)}`, r.sound);
    }
    this._echoToTable(ab.sound);
  },
  // SLAYER — Studied Target: mark ONE foe. A swift action (no save, no SR — it's an
  // Ex study of their guard), so the slayer still attacks this turn. Every attack
  // against the marked foe gains +N to hit & damage (applied in _swingVsAC). Any
  // foe, mindless or not — you're reading how it fights, not its thoughts.
  _abStudyTarget(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.studiedId = e.uid;
    m.studiedN = 1 + Math.floor((m.level || 1) / 5);
    this._note(`${ab.icon} ${m.nickname} STUDIES ${e.name} — reading its guard for the kill: +${m.studiedN} to hit and damage against it.`, ab.sound);
    this._echoToTable(ab.sound);
  },
  // CAVALIER — Challenge: swear an oath against ONE foe. Every strike the cavalier
  // lands on it this room deals +cavalier level in bonus DAMAGE (applied in
  // _swingVsAC via challengedId/challengeN). No save, no SR — it's a martial vow.
  // The room-use is spent by the framework (_useAbility line ~354).
  _abChallenge(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.challengedId = e.uid;
    m.challengeN = m.level || 1;
    this._note(`${ab.icon} ${m.nickname} issues a CAVALIER'S CHALLENGE against ${e.name} — sworn to cut it down: +${m.challengeN} damage on every blow against it this room.`, ab.sound);
    this._echoToTable(ab.sound);
  },
  // GLORIOUS CHALLENGE (Order of the Flame — Lord Gweyir): ONE action that challenges a foe AND
  // strikes it at once. Applies his CURRENT glory stack (+2×N damage via challengeN, −2×N AC via
  // gloriousAC), roars the burning shout, then attacks; if the blow FELLS the quarry, the stack
  // grows by one for next turn. FREE and unlimited — chain kills (fodder counts!) to pump it, then
  // loose the accumulated bonus on a real threat. Works identically for a human (the button) and
  // the bot (which targets the weakest foe to keep the streak rolling — see _allyAct).
  _abGloriousChallenge(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.challengedId = e.uid;
    m.challengeN = (m.level || 1) + 2 * (m.gloriousN || 0);   // base challenge + current glory (morale damage)
    m.gloriousAC = 2 * (m.gloriousN || 0);                    // recklessness: −AC while the Flame burns (see _acPenalty)
    const stacked = (m.gloriousN || 0) > 0;
    this._note(`🔥 ${m.nickname} bellows a GLORIOUS CHALLENGE at ${e.name}${stacked ? ` — the Flame ROARS (+${2 * m.gloriousN} damage, −${2 * m.gloriousN} AC)!` : ' — the Order of the Flame awakens!'}`, ab.sound);
    this._echoToTable(ab.sound);
    this._basicAttack(m, e.uid);   // ...and strike immediately (plays his estoc's attack sound after the shout)
    if (e.hp <= 0) { m.gloriousN = (m.gloriousN || 0) + 1; this._note(`🔥 ${m.nickname} stands triumphant over ${e.name} — GLORIOUS! The Flame swells to ${m.gloriousN}. (Unleash it again next turn.)`); }
  },
  // Charm Person — a living foe, Will save or CHARMED: it stops attacking the
  // party (only tends its own side) until a hero's blow snaps it out. Mindless
  // foes (undead/constructs) are immune; an already-charmed foe is left be.
  _abCharm(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    if (mindImmune(e)) { this._note(`${ab.icon} ${e.name} is immune to ${ab.name} — undead and constructs have no mind to charm.`); this._echoToTable(); return; }
    if (e.charmed) { this._note(`${ab.icon} ${e.name} is already charmed.`); return; }
    const dc = this._spellDC(m, ab);
    const sv = this._saveVs(this._enemySave(e, ab.save || 'will'), dc);
    const sound = ab.sound || pick(SND.stink);
    if (!sv.saved) { e.charmed = true; e.taunted = null; }
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${e.name} — Will ${sv.total} vs DC ${dc}: ${sv.saved ? 'resists' : "CHARMED! it won't attack your party (until struck)"}`, sound);
    this._echoToTable(sound); this._broadcast();
  },
  // Save-or-be-disabled (Hold Person): Will save or paralyzed.
  _abSaveDebuff(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    if (ab.debuff === 'paralyzed' && mindImmune(e)) { this._note(`${ab.icon} ${e.name} is immune to ${ab.name} — undead and constructs have no mind to seize.`); this._echoToTable(); return; }
    const dc = this._spellDC(m, ab);
    const sv = this._saveVs(this._enemySave(e, ab.save || 'will'), dc);
    const sound = ab.sound || pick(SND.stink);
    // Hold Person / Hideous Laughter: HELD for up to 1 round per caster level,
    // but a NEW Will save each of the foe's turns can end it early (the re-save
    // costs its turn either way) — see the heldDC handling in _advanceToActor.
    if (!sv.saved && ab.debuff === 'paralyzed') { e.paralyzed = Math.max(2, Math.min(12, m.level || 1)); e.heldDC = dc; }
    else if (!sv.saved && ab.debuff === 'sickened') e.nauseated = SICKENED_ROUNDS;   // save-or-NAUSEATED (Stinking Cloud): retches, loses turns while it lingers
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${e.name} — save ${sv.total} vs DC ${dc}: ${sv.saved ? 'resists' : `${(ab.debuff === 'sickened' ? 'NAUSEATED' : String(ab.debuff).toUpperCase())}!`}`, sound);
    this._echoToTable(sound);
  },
  // Touch spell (Shocking Grasp): a ranged touch attack for level d6.
  _abTouch(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    const touchAC = this._enemyAC(e, { touch: true });
    const toHit = this._spellToHit(m) + ((m.buffs && m.buffs.toHit) || 0);   // casting-stat mod (house rule), + any combat buffs (e.g. magus melee touch)
    const roll = dRoll(20), total = roll + toHit;
    const sound = ab.sound || pick(SND.lightning);
    if (roll !== 20 && (roll === 1 || total < touchAC)) { this._note(`${ab.icon} ${m.nickname}'s ${ab.name} misses ${e.name}. [touch d20 ${roll} ${this._fmtBonus(toHit)} = ${total} vs ${touchAC}]`, sound); this._echoToTable(sound); return; }
    // SEARING LIGHT (ab.searing) — PF1's per-target-type damage table:
    //   • normal creature        : 1d8 per 2 levels (max 5d8)  [the ab.die/dice default]
    //   • undead                 : 1d6 per level     (max 10d6)
    //   • light-vulnerable undead: 1d8 per level     (max 10d8)  — vampires (sunlight!)
    //   • construct / object     : 1d6 per 2 levels  (max 5d6)
    let dice, die, undeadTag = '';
    if (ab.searing) {
      const lvl = Math.max(1, m.level || 1);
      const lightVuln = e.lightVuln || /vampire/i.test(e.name || '');   // vampires (sunlight!) — even if the type field is loose
      if (lightVuln)                  { dice = Math.min(10, lvl);                          die = 8; undeadTag = ' — the holy light SCOURGES it!'; }
      else if (e.type === 'undead')   { dice = Math.min(10, lvl);                          die = 6; undeadTag = ' — SEARS the undead!'; }
      else if (e.type === 'construct'){ dice = Math.max(1, Math.min(5, Math.floor(lvl / 2))); die = 6; undeadTag = ' (a construct — the light barely marks it)'; }
      else                            { dice = this._spellDice(ab, m);                     die = ab.die || 8; }
    } else {
      dice = this._spellDice(ab, m); die = ab.die || 6;
    }
    const raw = Math.max(1, this._rollSpell(m, dice, die, ab));
    const dmg = this._dmgE(e, raw, ab.dtype);
    // Lifesteal rider (antipaladin Vampiric Touch) — heal the caster by the
    // energy actually dealt, same as the magus spellstrike version.
    let stealNote = '';
    if (ab.lifesteal && dmg > 0 && m.hp > 0) {
      const before = m.hp; m.hp = Math.min(m.maxHp, m.hp + dmg);
      if (m.hp > before) stealNote = ` ${m.nickname} DRINKS ${m.hp - before} HP back.`;
    }
    let dotNote = '';
    if (ab.dot && e.hp > 0) {   // Acid Arrow: it keeps eating away each of the foe's turns.
      const rounds = Math.min(5, Math.max(1, Math.floor((m.level || 1) / 3)));   // 1 round per 3 caster levels
      e.acid = { rounds, dice: Math.max(1, Math.floor(dice / 2)), die: ab.die || 6 };   // a fading burn (half the initial dice)
      dotNote = ` It clings and KEEPS BURNING (${rounds} more round${rounds > 1 ? 's' : ''}).`;
    }
    this._note(`${ab.icon} ${m.nickname}'s ${ab.name} hits ${e.name} for ${dmg} ${ab.dtype || ''}${this._resistTag(e, ab.dtype)}${undeadTag}.${stealNote}${dotNote}${this._afterEnemyHit(e)}`, sound);
    if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    this._echoToTable(sound);
  },
  // Grease: up to maxTargets foes Reflex-save or slip prone (and lose the turn).
  _abGrease(m, ab, payload) {
    const dc = this._spellDC(m, ab);
    // Grease is slippery enough to let a GRAPPLED ally slither out of the chains.
    if (ab.effect === 'grease') for (const a of this.livingParty()) {
      if (a.grappled) { a.grappled = false; a.grappledBy = null; this._note(`🛢️ ${a.nickname} slips free of the grapple in the grease!`); }
    }
    // Gust of Wind hits a RANDOM 1d3 foes (randFoes); Grease targets the picked
    // ones. Save type is configurable (Grease=Reflex, Gust=Fort).
    let chosen;
    if (ab.randN || ab.randFoes) {
      const living = this._targetableEnemies().slice();
      for (let i = living.length - 1; i > 0; i--) { const j = dRoll(i + 1) - 1; [living[i], living[j]] = [living[j], living[i]]; }
      // randN d randDie (e.g. Entangle = 2d4) OR a single 1dN (randFoes).
      let count = 0;
      if (ab.randN) { for (let i = 0; i < ab.randN; i++) count += dRoll(ab.randDie || 4); }
      else count = dRoll(ab.randFoes);
      chosen = living.slice(0, count);
    } else {
      chosen = this._enemyTargets(payload, ab.maxTargets || 2);
    }
    const saveType = ab.save || 'reflex';
    const lbl = saveType === 'fort' ? 'Fort' : saveType === 'will' ? 'Will' : 'Ref';
    const sound = ab.sound || pick(SND.flesh), parts = [];
    let failN = 0, saveN = 0, airN = 0;
    for (const e of chosen) {
      if (e.flying) { airN++; parts.push(`${e.name}: airborne — can't be tripped (immune to prone)`); continue; }
      const sv = this._saveVs(this._enemySave(e, saveType), dc);
      if (!sv.saved) { e.prone = true; e.loseTurn = true; failN++; } else saveN++;
      parts.push(`${e.name}: ${lbl} ${sv.total} vs ${dc} ${sv.saved ? 'stays up' : 'KNOCKED prone'}`);
    }
    // 3+ targets → counts only; the prone markers tell the rest.
    const detail = chosen.length <= 2 ? parts.join('; ')
      : `${failN} KNOCKED prone, ${saveN} stay up${airN ? `, ${airN} airborne (immune)` : ''} [${lbl} DC ${dc}]`;
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${chosen.length} foe${chosen.length === 1 ? '' : 's'} — ${detail}.`, sound);
    this._echoToTable(sound);
  },
  // Sleep: the weakest foes (lowest HP) must make a Will save or fall asleep —
  // helpless (flat-footed) and losing turns until something strikes them.
  _abSleep(m, ab, payload) {
    const dc = this._spellDC(m, ab);
    const chosen = this._enemyTargets(payload, ab.maxTargets || 3).filter(e => !ccd(e) && !mindImmune(e)).slice().sort((a, b) => a.hp - b.hp);   // skip already-CC'd foes + mind-immune (undead/construct)
    if (!chosen.length) { this._note(`${ab.icon} ${m.nickname} casts ${ab.name}, but those foes are immune or already entranced.`); this._echoToTable(); return; }
    const sound = ab.sound || pick(SND.flesh), parts = [];
    let failN = 0, saveN = 0;
    for (const e of chosen) {
      const sv = this._saveVs(this._enemySave(e, 'will'), dc);
      if (!sv.saved) { e.fascinated = true; e.asleep = true; e.flatFooted = true; failN++; } else saveN++;   // asleep: skip turns (woken by a hit) + helpless
      parts.push(`${e.name}: Will ${sv.total} vs ${dc} ${sv.saved ? 'shrugs it off' : '💤 ASLEEP'}`);
    }
    // 3+ targets → counts only; the 💤 chips show who's down.
    const detail = chosen.length <= 2 ? parts.join('; ') : `${failN} fall 💤 ASLEEP, ${saveN} shrug it off [Will DC ${dc}]`;
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${chosen.length} foe${chosen.length === 1 ? '' : 's'} — ${detail}.`, sound);
    this._echoToTable(sound);
  },
  // Slow: a RANDOM 2d4 foes must make a Will save or be SLOWED for ~1 round per
  // caster level — sluggish (acts only every other turn) and a touch easier to
  // hit (−1 AC). Plays the Evil Morty theme.
  _abSlow(m, ab, payload) {
    const dc = this._spellDC(m, ab);
    const living = this._targetableEnemies().slice();
    for (let i = living.length - 1; i > 0; i--) { const j = dRoll(i + 1) - 1; [living[i], living[j]] = [living[j], living[i]]; }
    const n = dRollN(ab.randN || 2, ab.randDie || 4);   // 2d4 targets
    const chosen = living.slice(0, n);
    const dur = Math.max(3, Math.min(10, m.level || 1));
    const sound = ab.sound || pick(SND.flesh), parts = [];
    let failN = 0, saveN = 0;
    for (const e of chosen) {
      const sv = this._saveVs(this._enemySave(e, ab.save || 'will'), dc);
      if (!sv.saved) { e.slowed = Math.max(e.slowed || 0, dur); e._slowTick = 0; failN++; } else saveN++;
      parts.push(`${e.name}: Will ${sv.total} vs ${dc} ${sv.saved ? 'resists' : '🐌 SLOWED'}`);
    }
    // 3+ targets → "Bob casts Slow on 7 foes — 4 SLOWED, 3 resist." The 🐌
    // condition chips carry the per-foe answer for anyone who wants it.
    const detail = chosen.length <= 2 ? parts.join('; ') : `${failN} 🐌 SLOWED, ${saveN} resist [Will DC ${dc}]`;
    this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${chosen.length} foe${chosen.length === 1 ? '' : 's'} — ${detail}.`, sound);
    this._echoToTable(sound);
  },
  // Fascinate: up to maxTargets foes stand enthralled, losing turns until struck.
  // Darkness (wizard/sorcerer): shroud a RANDOM 1d3 foes — they can't act AND can't
  // be targeted for 2 of their turns (see _advanceToActor decrement + _targetableEnemies).
  _abDarkness(m, ab) {
    const living = this._targetableEnemies().slice();   // don't re-darken already-shrouded foes
    for (let i = living.length - 1; i > 0; i--) { const j = dRoll(i + 1) - 1; [living[i], living[j]] = [living[j], living[i]]; }
    const n = (ab.randBase || 0) + dRoll(ab.randDie || ab.randFoes || 3);   // Darkness: 1d4+1 foes
    const chosen = living.slice(0, n);
    if (!chosen.length) { this._note(`${ab.icon} ${m.nickname} conjures ${ab.name}, but there's no one to shroud.`); this._echoToTable(); return; }
    for (const e of chosen) { e.darkened = 2; e.flatFooted = true; }
    const sound = ab.sound || pick(SND.stink);
    this._note(`${ab.icon} ${m.nickname} drowns ${chosen.map(e => e.name).join(', ')} in DARKNESS — gone for 2 rounds (can't act, can't be hit).`, sound);
    this._echoToTable(sound);
  },
  _abFascinate(m, ab, payload) {
    const chosen = this._enemyTargets(payload, ab.maxTargets || 3).filter(e => !ccd(e) && !mindImmune(e));   // skip already-CC'd foes + mind-immune (undead/construct)
    if (!chosen.length) { this._note(`${ab.icon} ${m.nickname} begins ${ab.name}, but those foes are immune or already entranced.`); return; }
    for (const e of chosen) e.fascinated = true;
    const sound = ab.sound || pick(SND.flesh);
    this._note(`${ab.icon} ${m.nickname} performs ${ab.name} — ${chosen.length} foe${chosen.length === 1 ? '' : 's'} stand${chosen.length === 1 ? 's' : ''} fascinated (until struck).`, sound);   // COUNT, not a per-foe roll call (Josh 2026-07-08 — same as channel/AoE reports)
    this._echoToTable(sound);
  },
  // Heal: 'party' (channel) heals all living allies; 'channel' (lay on hands)
  // heals the most-wounded ally (or self).
  // Hero's Defiance — a downed paladin's clutch self-rescue, auto-fired from the
  // turn loop when they're at 0 HP or below but NOT dead. PF1: they instantly
  // receive a lay-on-hands worth of healing (½ level d6, min 1d6). Once per room,
  // from LEVEL 1 (home-rule: paladin spellcasting starts at 1st). Guaranteed to
  // bring them to at least 1 HP so they return to functionality. Returns true if
  // it fired.
  _tryHeroesDefiance(m) {
    if (!m || (m.cls !== 'paladin' && m.cls !== 'antipaladin')) return false;
    if (!m.heroDefiance || m.heroDefiance <= 0) return false;
    m.heroDefiance -= 1;
    const lvl = m.level || 1;
    const heal = Math.max(1, dRollN(Math.max(1, Math.ceil(lvl / 2)), 6));   // lay-on-hands worth
    m.hp = Math.min(m.maxHp, Math.max(1, m.hp + heal));   // always back on their feet (>= 1 HP)
    m.downed = false;
    this._note(`✨ ${m.nickname} refuses to fall — HERO'S DEFIANCE! Heals ${heal} and rises (${m.hp}/${m.maxHp}).`, '/audio/spell_revive.mp3');
    this._echoToTable('/audio/spell_revive.mp3');
    return true;
  },
  // Adimarus's CHANNEL NEGATIVE — the dark mirror of Channel Positive: the same
  // ½ level d6 burst, but it mends the party's UNDEAD members (who take nothing
  // from positive energy). The living feel only a cold draft.
  // SELECTIVE CHANNELING (feat — every channeler takes it early, see the note at
  // CLERIC_FEAT_AT): both channel handlers below touch ONLY intended targets.
  // Channel Negative mends the undead comrades and the living take nothing;
  // Channel Positive heals the party (never foes) and its sear mode burns only
  // enemy undead, never an undead comrade. The feat slot pays for all of it.
  _abChannelNeg(m, ab) {
    const lvl = m.level || 1;
    const sound = ab.sound || pick(SND.flesh);
    const undead = this.present().filter(a => !a.dead && a.undead);
    if (!undead.length) { this._note(`${ab.icon} ${m.nickname} holds the negative channel — no undead comrades to mend.`); this._echoToTable(); return; }
    const h = Math.max(1, dRollN(Math.max(1, Math.ceil(lvl / 2)), 6));
    const revived = [];   // concise report (Josh): amount + revives, not per-member HP
    for (const a of undead) {
      const wasDown = a.hp <= 0;
      a.hp = Math.min(a.maxHp, a.hp + h);
      if (wasDown && a.hp > 0) { a.downed = false; revived.push(a.nickname); }
    }
    const upNote = revived.length ? ` ${revived.join(' & ')} back up!` : '';
    this._note(`${ab.icon} ${m.nickname} channels NEGATIVE energy — black vitality knits the undead for +${h} HP.${upNote}`, sound);
    this._echoToTable(sound);
  },
  _abHeal(m, ab, payload) {
    const lvl = m.level || 1;
    const sound = ab.sound || pick(SND.flesh);
    // Channel Positive — PF1e positive-energy burst: ½ caster level d6 (1d6 at
    // L1, +1d6 every 2 levels → 6d6 at L11), to the whole party. VESORIANNA
    // (Shelyn / Life — a ghost who PROTECTS life) channels at +2 caster levels,
    // reflecting her healing focus (Tobias).
    const chLvl = lvl + (((m.playerId || '').toLowerCase() === 'vesorianna') ? 2 : 0);
    // HEALING domain (passive — Healer's Blessing): cures & channels heal +1 PER DIE.
    const _hb = m.domainHealBoost ? 1 : 0;
    const _chDice = Math.max(1, Math.ceil(chLvl / 2));
    const channelAmt = () => Math.max(1, dRollN(_chDice, 6) + _hb * _chDice);
    // Cure X Wounds — healDice d8 + caster level (capped: +5 light, +10 moderate).
    const cureAmt = () => Math.max(1, dRollN(ab.healDice || 1, 8) + Math.min(ab.healCap || lvl, lvl) + _hb * (ab.healDice || 1));
    if (ab.heal === 'party') {
      // Offensive channel (PF1 cleric): if NOBODY needs healing but UNDEAD are on
      // the field, channeling positive energy SEARS them instead — ½ level d6, a
      // Will save (DC 10 + ½ level + casting mod) for half. Auto-decided so both
      // bots and humans channel sensibly: heal the living, else harm the undead.
      // UNDEAD party members (Tar Baphon, Vrood, Vesorianna, Farrus) take NOTHING
      // from positive energy — they don't count as wounded here and the burst
      // passes over them below (Infernal Healing / Channel Negative is their cure).
      const woundedAllies = this.present().filter(a => !a.dead && !a.undead && a.hp < a.maxHp);
      const undead = this._targetableEnemies().filter(e => e.type === 'undead');
      // The caster may FORCE the mode (Tobias: channel offensive vs defensive):
      //   'offensive' → sear the undead   ·   'defensive' → heal the party
      // No mode = the old auto-pick (heal if anyone's hurt, else sear undead).
      const mode = payload && payload.mode;
      const wantSear = (mode === 'offensive') || (!mode && !woundedAllies.length);
      if (mode === 'offensive' && !undead.length) {
        this._note(`${ab.icon} ${m.nickname} readies an OFFENSIVE channel — but there are no undead here to sear; the energy mends the party instead.`);
      }
      if (wantSear && undead.length) {
        // COUNTS-ONLY report (Josh): a channel that sears undead lists a tally, not
        // per-enemy damage. Will DC + the burst damage + hit/saved/slain counts.
        // SUN domain (passive — Sun's Blessing, PF1): +cleric level to the sear.
        const dmg = channelAmt() + (m.domainSunVuln ? lvl : 0), dc = 10 + Math.floor(lvl / 2) + CAST_MOD;
        let hitN = 0, savedN = 0, slainN = 0;
        for (const e of undead) {
          const sv = this._saveVs(this._enemySave(e, 'will'), dc);
          this._dmgE(e, sv.saved ? Math.floor(dmg / 2) : dmg, 'positive');
          if (sv.saved) savedN++; else hitN++;
          if (e.hp <= 0) slainN++;
        }
        const tally = `${hitN} seared${savedN ? `, ${savedN} saved` : ''}${slainN ? `, ${slainN} destroyed` : ''}`;
        this._note(`${ab.icon} ${m.nickname} channels positive energy — SEARS the undead, Will DC ${dc} (${dmg}): ${tally}.`, sound);
        this._echoToTable(sound);
        return;
      }
      // PF1e: a channel rolls its healing ONCE and heals EVERY hero in the burst.
      // That includes the DOWNED/dying (negative HP but not dead at −10) — a
      // channel is positive energy and can pull a dying ally back onto their feet.
      const allies = this.present().filter(a => !a.dead && !a.undead);
      // MASS HEAL (cleric 9th) rides the party-heal path but rolls CURE-sized dice
      // (15d8 + CL) instead of the channel's ½level d6 burst.
      const h = ab.massHeal ? cureAmt() : channelAmt();
      // Concise report (Josh): a channel announces the HEAL AMOUNT + anyone it
      // pulled back to their feet — NOT every member's HP. (The old per-member
      // "Name X/Y" list got read aloud as a full party-health dump that buried
      // the actual combat narration.) Blind players check party HP with the H key.
      const revived = [];
      for (const a of allies) {
        const wasDown = a.hp <= 0;
        a.hp = Math.min(a.maxHp, a.hp + h);
        a._bleeding = false;   // magical healing staunches a Bleeding Touch wound
        if (wasDown && a.hp > 0) { a.downed = false; revived.push(a.nickname); }   // back on their feet
      }
      const upNote = revived.length ? ` ${revived.join(' & ')} back up!` : '';
      const skippedUndead = this.present().filter(a => !a.dead && a.undead);
      const skipNote = skippedUndead.length ? ` The positive energy washes over ${skippedUndead.map(a => a.nickname).join(' & ')} without effect.` : '';
      this._note(`${ab.icon} ${m.nickname} channels positive energy — heals the party for +${h} HP.${upNote}${skipNote}`, sound);
    } else {
      // Target the MOST-HURT ally who is NOT dead — INCLUDING a downed/dying ally
      // (hp <= 0 but not slain at -10). (Was livingParty() = hp>0, so a cure could
      // skip a bleeding-out ally and land on someone barely scratched.) A cure
      // that lifts a downed ally above 0 puts them back on their feet.
      const cands = this.present().filter(a => !a.dead && !a.undead);   // a cure spell can't touch the undead comrades
      // The caster's CHOSEN ally (unless they picked an undead comrade a cure
      // can't touch), else the most-hurt — INCLUDING a downed/dying ally.
      const picked = this._pickedAlly(payload);
      const target = (picked && !picked.undead) ? picked
                   : (cands.slice().sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0] || m);
      const wasDown = target.hp <= 0;
      const h = cureAmt(); target.hp = Math.min(target.maxHp, target.hp + h);
      target._bleeding = false;   // magical healing staunches a Bleeding Touch wound
      const up = wasDown && target.hp > 0;
      if (up) target.downed = false;   // healed back to consciousness
      this._note(`${ab.icon} ${m.nickname} casts ${ab.name} — ${target.nickname} heals ${h} (${target.hp}/${target.maxHp})${up ? ' ⤴up!' : ''}.`, sound);
    }
    this._echoToTable(sound);
  },
  // Sticky room buff (Rage / Judgment / Bane / Inspire). `party` spreads it.
  // Grant temporary HP (rage's / Bear's Endurance's Con bonus) — boosts current
  // AND max HP; reverted when the buff ends (room reset, see _resetAbilities).
  _grantTempHp(who, amount) {
    if (!amount) return;
    who.tempHp = (who.tempHp || 0) + amount;
    who.maxHp += amount; who.hp += amount;
  },
  // Pick the single ally a target:'ally' buff lands on — the player's chosen one,
  // else a bot picks by intent (most-hurt for Bear's, a martial for Bull's…).
  // The ally a HUMAN explicitly chose for a targeted spell (party-card click →
  // allyUid; the blind ally-picker and older flows → targetUid as a fallback).
  // Returns the present (not-left) member, or null when nothing valid was picked
  // → the caller falls back to its smart auto-pick, exactly like the AI does.
  // `opts.alive` excludes the dead/dying (e.g. you can't turn a corpse invisible);
  // heals/revives leave it off so they can reach a downed ally.
  _pickedAlly(payload, opts = {}) {
    const id = payload && (payload.allyUid || payload.targetUid);
    if (!id) return null;
    const a = this.present().find(x => x.playerId === id || x.uid === id);
    if (!a) return null;
    if (opts.alive && (a.dead || a.hp <= 0)) return null;
    return a;
  },
  _buffTarget(m, ab, payload) {
    const allies = this.livingParty();
    // Explicit pick first: allyUid is the party-card selection; targetUid is kept
    // as a fallback (older payloads / blind flows). Invalid explicit picks were
    // already refused in _useAbility, so a hit here is a valid recipient.
    if (payload && (payload.allyUid || payload.targetUid)) {
      const t = allies.find(a => a.playerId === (payload.allyUid || payload.targetUid));
      if (t) return t;
    }
    const MARTIAL = ['fighter', 'barbarian', 'paladin', 'antipaladin', 'ranger', 'rogue', 'magus', 'cavalier', 'monk', 'inquisitor'];
    // A sticky buff WON'T stack — re-casting it on an ally who already has it is a
    // wasted slot/turn. So pick only from allies who DON'T have THIS buff yet; if
    // everyone already has it, fall back to the full list (the bot's buffFullyUp
    // gate, which calls this too, then sees the buff is up and skips the cast).
    const has = (a) => !!(a.buffApplied && a.buffApplied[ab.key]);
    const eligible = allies.filter(a => !has(a));
    const pool = eligible.length ? eligible : allies;
    const acScore = (a) => this._acOf(a).ac + this._acBonus(a) - this._acPenalty(a);
    if (ab.key === 'shieldoffaith') {   // lowest-AC ally who'd actually GAIN deflection (ring/existing SoF < the spell)
      const def = (ab.buff && ab.buff.deflect) || 0;
      const gains = (a) => (Number(a.gear && a.gear.ring) || 0) < def && ((a.buffs && a.buffs.deflect) || 0) < def;
      const gainers = pool.filter(gains);
      return (gainers.length ? gainers : pool).slice().sort((a, b) => acScore(a) - acScore(b))[0] || m;
    }
    if (ab.key === 'bearsendurance') return pool.slice().sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0] || m;
    if (ab.key === 'catsgrace')      return pool.find(a => a.cls === 'ranger' || isSneakClass(a.cls)) || pool.find(a => MARTIAL.includes(a.cls)) || m;
    if (ab.key === 'bullsstrength')  return pool.find(a => MARTIAL.includes(a.cls) && a.playerId !== m.playerId) || pool.find(a => MARTIAL.includes(a.cls)) || m;
    if (ab.key === 'stoneskin')      return pool.filter(a => !a.dr).slice().sort((a, b) => a.hp - b.hp)[0] || pool.slice().sort((a, b) => a.hp - b.hp)[0] || m;   // least-HP ally without it
    return m;
  },
  // ── STANCE TOGGLES (Power Attack / Deadly Aim) ──────────────────────────────
  // Both are FREE, no-cost stances that stay on until flipped off — including ACROSS
  // rooms (re-asserted silently by _resetAbilities). Shared helpers so the toggle,
  // the silent room re-apply, and the bot's high-AC "ease off" decision all run the
  // same math. on=true applies, on=false backs out exactly what was put on.
  _applyDeadlyAim(m, on, { silent, sound } = {}) {
    m.buffApplied = m.buffApplied || {};
    m.buffs = m.buffs || { toHit: 0, dmg: 0, bonusDice: 0, acPen: 0, save: 0, ac: 0, deflect: 0 };
    if (!on) {
      if (!m.buffApplied.deadlyaim) return;
      m.buffApplied.deadlyaim = false; m.aimOn = false;
      m.buffs.toHit += 2; m.buffs.dmg -= (m._aimBonus || 0); m._aimBonus = 0;
      if (!silent) { this._note(`🎯 ${m.nickname} eases off Deadly Aim — steadier, lighter shots for a surer hit.`, sound); this._echoToTable(sound); }
      return;
    }
    if (m.buffApplied.deadlyaim) return;
    const dmg = 2 + 2 * Math.floor(((m.level || 1) - 1) / 4);   // +2 at 1-4, +4 at 5-8, +6 at 9-12…
    m.buffApplied.deadlyaim = true; m.aimOn = true; m._aimBonus = dmg;
    m.buffs.toHit -= 2; m.buffs.dmg += dmg;
    if (!silent) { this._note(`🎯 ${m.nickname} sets Deadly Aim — −2 to hit, +${dmg} damage on every shot.`, sound); this._echoToTable(sound); }
  },
  _applyPowerAttack(m, on, { silent, sound } = {}) {
    m.buffApplied = m.buffApplied || {};
    m.buffs = m.buffs || { toHit: 0, dmg: 0, bonusDice: 0, acPen: 0, save: 0, ac: 0, deflect: 0 };
    if (!on) {   // back out exactly what we put on
      if (!m.buffApplied.powerattack) return;
      m.buffApplied.powerattack = false; m.paOn = false;
      m.buffs.toHit += (m._paPen || 0); m.buffs.dmg -= (m._paBonus || 0);
      m._paPen = 0; m._paBonus = 0;
      // Toggling OFF plays a distinct "shh" so a (blind) player can hear the
      // difference between turning it ON (rage grunt) and OFF.
      if (!silent) { this._note(`💥 ${m.nickname} eases off Power Attack — a measured guard for a surer hit.`, '/audio/shh.mp3'); this._echoToTable('/audio/shh.mp3'); }
      return;
    }
    if (m.buffApplied.powerattack) return;
    const w = weaponOf(m.gear, m.weaponKey);
    const pen = 1 + Math.floor(babFor(m.cls || 'fighter', m.level || 1) / 4);   // −1 per +4 BAB
    const bonus = Math.floor(pen * 2 * (w.cat === '2h' ? 1.5 : 1));             // +2 per −1, ×1.5 two-handed
    m.buffApplied.powerattack = true; m.paOn = true; m._paPen = pen; m._paBonus = bonus;
    m.buffs.toHit -= pen; m.buffs.dmg += bonus;
    if (!silent) { this._note(`💥 ${m.nickname} hauls into Power Attack — −${pen} to hit, +${bonus} damage on every blow.`, sound); this._echoToTable(sound); }
  },
  // FIGHT DEFENSIVELY — a stance toggle like Power Attack: −4 to all attacks (and
  // combat maneuvers, via buffs.toHit) for a +2 DODGE AC (+3 for the acrobatic
  // classes — monks etc. who'd have the Acrobatics ranks). The dodge bonus is real
  // (summed in _acBonus, dropped when flat-footed in _heroACs). m.fdOn re-asserts
  // the stance across rooms, exactly like paOn/aimOn.
  _applyFightDefensively(m, on, { silent, sound } = {}) {
    m.buffApplied = m.buffApplied || {};
    m.buffs = m.buffs || { toHit: 0, dmg: 0, bonusDice: 0, acPen: 0, save: 0, ac: 0, deflect: 0 };
    if (!on) {
      if (!m.buffApplied.fightdefensively) return;
      m.buffApplied.fightdefensively = false; m.fdOn = false;
      m.buffs.toHit += 4; m._fdAc = 0;
      if (!silent) { this._note(`🛡️ ${m.nickname} drops the defensive guard — back to full commitment.`, '/audio/shh.mp3'); this._echoToTable('/audio/shh.mp3'); }
      return;
    }
    if (m.buffApplied.fightdefensively) return;
    const dodge = ['monk', 'rogue', 'swashbuckler', 'ranger'].includes(m.cls) ? 3 : 2;   // PF1: +2, or +3 with 3 ranks of Acrobatics
    m.buffApplied.fightdefensively = true; m.fdOn = true; m._fdAc = dodge;
    m.buffs.toHit -= 4;
    if (!silent) { this._note(`🛡️ ${m.nickname} fights defensively — −4 to hit, +${dodge} dodge AC.`, sound); this._echoToTable(sound); }
  },
  _abBuff(m, ab, payload) {
    const sound = ab.sound || pick(SND.flesh);
    const lvl = m.level || 1;
    // A MANUAL Inspire Courage cast scales like the auto-aura (PF1 progression).
    if (ab.key === 'inspire' && ab.buff) { const b = this._inspireBonus(lvl); ab = { ...ab, buff: { ...ab.buff, toHit: b, dmg: b } }; }
    // Power Attack / Deadly Aim / Fight Defensively — stance toggles; shared helpers.
    if (ab.deadlyaim)        { this._applyDeadlyAim(m, !(m.buffApplied && m.buffApplied.deadlyaim), { sound }); return; }
    if (ab.powerattack)      { this._applyPowerAttack(m, !(m.buffApplied && m.buffApplied.powerattack), { sound }); return; }
    if (ab.fightdefensively) { this._applyFightDefensively(m, !(m.buffApplied && m.buffApplied.fightdefensively), { sound }); return; }
    // RAGE — scales like PF1e (Greater at 11, Mighty at 20) and pumps Con → HP.
    if (ab.key === 'rage') {
      m.buffApplied = m.buffApplied || {};
      if (m.buffApplied.rage) return;   // already raging this room
      m.buffApplied.rage = true;
      const mod = lvl >= 20 ? 4 : lvl >= 11 ? 3 : 2;   // +8/+6/+4 Str & Con → +4/+3/+2 mod
      m.buffs = m.buffs || { toHit: 0, dmg: 0, bonusDice: 0, acPen: 0, save: 0, ac: 0, deflect: 0 };
      m.buffs.toHit += mod;          // Strength to hit
      m.buffs.dmg   += mod + 1;      // Strength to damage (+1 for a two-hander)
      m.buffs.save  += mod;          // morale bonus to Will
      m.buffs.acPen += 2;            // −2 AC while raging
      const hp = mod * lvl;          // +Con mod per Hit Die
      this._grantTempHp(m, hp);
      const tier = lvl >= 20 ? 'MIGHTY ' : lvl >= 11 ? 'GREATER ' : '';
      this._note(`😤 ${m.nickname} flies into a ${tier}RAGE!`, sound);   // the numbers live on the buff chip — the bellow is enough (Josh 2026-07-04)
      this._echoToTable(sound);
      return;
    }
    // Inspire Courage scales with BARD level, PF1-style: +1, rising to +2/+3/+4
    // at caster level 5 / 11 / 17. (`lvl` is the caster's level.)
    const inspMod = lvl >= 17 ? 4 : lvl >= 11 ? 3 : lvl >= 5 ? 2 : 1;
    const gmwMod = Math.min(5, Math.floor(lvl / 4));   // Greater Magic Weapon: +1 enhancement per 4 caster levels (max +5)
    const apply = (who) => {
      who.buffApplied = who.buffApplied || {};
      if (ab.sticky && who.buffApplied[ab.key]) return;   // already active this room — don't stack
      if (ab.sticky) who.buffApplied[ab.key] = true;
      if (ab.persist) {   // Bless / Inspire: a run-long buff that survives room resets (never fades)
        const tH = ab.key === 'inspire' ? inspMod : ((ab.buff && ab.buff.toHit) || 0);
        const dG = ab.key === 'inspire' ? inspMod : ((ab.buff && ab.buff.dmg) || 0);
        who.runBuffs = who.runBuffs || { toHit: 0, dmg: 0 };
        who.runBuffs.toHit += tH;
        who.runBuffs.dmg   += dG;
        who.runBuffApplied = who.runBuffApplied || {};
        who.runBuffApplied[ab.key] = true;
        return;
      }
      who.buffs = who.buffs || { toHit: 0, dmg: 0, bonusDice: 0, acPen: 0, save: 0, ac: 0, deflect: 0 };
      who.buffs.toHit += ab.gmw ? gmwMod : ((ab.buff && ab.buff.toHit) || 0);   // Greater Magic Weapon scales the enhancement with caster level
      who.buffs.dmg += ab.gmw ? gmwMod : ((ab.buff && ab.buff.dmg) || 0);
      who.buffs.bonusDice += (ab.buff && ab.buff.bonusDice) || 0;
      who.buffs.acPen += (ab.buff && ab.buff.acPen) || 0;   // rage handled above; here magus Shield etc.
      who.buffs.ac += (ab.buff && ab.buff.ac) || 0;         // Shield / Cat's Grace: +AC armor/dodge bonus (sticky, stacks)
      // DEFLECTION bonus (Shield of Faith): does NOT stack with itself OR a Ring of
      // Protection — take the HIGHEST. The AC math (Dungeon._acBonus) adds only the
      // excess of this over the ring's deflection.
      who.buffs.deflect = Math.max(who.buffs.deflect || 0, (ab.buff && ab.buff.deflect) || 0);
      who.buffs.save += (ab.buff && ab.buff.save) || 0;
      who.buffs.dexMod = (who.buffs.dexMod || 0) + ((ab.buff && ab.buff.dexMod) || 0);   // Cat's Grace: +Dex modifier — feeds the reach-weapon AoO count (Combat Reflexes)
      if (ab.buff && ab.buff.conHp) this._grantTempHp(who, ab.buff.conHp * (who.level || 1));   // Bear's Endurance
      if (ab.dr) who.dr = Math.max(who.dr || 0, ab.dr);   // Stoneskin — DR vs physical blows
      if (ab.protectFire) who.protectFire = Math.min(120, 12 * (m.level || 1));   // PF1 Protection from Energy: an absorption pool — 12 per caster level, max 120
      if (ab.darkvision) who.darkvision = true;   // Darkvision (Communal): the party can target foes shrouded in magical darkness
      if (ab.fly) who.flying = true;                // Fly — grounded foes can't melee them
      if (ab.canHitFlyers) who.canHitFlyers = true; // Magus Fly/Overland Flight — can melee airborne foes
      if (ab.displace) who.displaced = true;        // Displacement — 50% incoming-miss (this room)
      if (ab.fireShield) who.fireShield = { die: 6, bonus: who.level || 1 };   // Fire Shield — retaliate on melee hit
      if (ab.elemBody) who.elemBody = true;         // Elemental Body — crit + CC immunity
      if (ab.trueSeeing) who.trueSeeing = true;     // True Seeing — pierce darkness/illusion/invisibility
    };
    if (ab.party) {
      for (const a of this.livingParty()) apply(a);
      // Prayer floods the WHOLE battlefield — allies up, enemies down (−1 to hit,
      // damage & saves for the room). See _monsterSwing / _enemySave.
      if (ab.enemyPenalty) for (const e of this.livingEnemies()) e.prayed = Math.max(e.prayed || 0, ab.enemyPenalty);
      const inspTag = ab.key === 'inspire' ? ` (+${inspMod} to hit & damage)` : ab.gmw ? ` (weapons +${gmwMod} to hit & damage)` : '';
      this._note(`${ab.icon} ${m.nickname} ${ab.enemyPenalty ? `intones ${ab.name} — allies blessed, enemies cursed across the field` : ab.gmw ? `blesses the party's weapons with ${ab.name}` : `strikes up ${ab.name} — the party is emboldened`}${inspTag}!`, sound);
    }
    else if (ab.target === 'ally') { const t = this._buffTarget(m, ab, payload); apply(t); this._note(`${ab.icon} ${m.nickname} casts ${ab.name} on ${t.nickname}.`, sound); }
    else { apply(m); this._note(`${ab.icon} ${m.nickname} uses ${ab.name}!`, sound); }
    this._echoToTable(sound);
  },
  // Taunt (barbarian): a roaring challenge — every enemy makes a Will save or is
  // COMPELLED to attack the barbarian on its next turn (see _enemyAct), pulling
  // fire off the rest of the party. Once per room.
  _abTaunt(m, ab) {
    const dc = 10 + Math.floor((m.level || 1) / 2) + ABILITY_MOD;   // martial intimidation DC
    // Per-character taunt voice: Farrus (the Butcher, Farrah's grandpa ghost)
    // roars by summoning grandpa. Tokala + other barbarians keep the predator
    // yell (ab.sound); goblin barbarians use their own yell via _enemyTaunt.
    const TAUNT_VOICE = { 'farrus richton': '/audio/farrah_summon_grandpa_short.mp3' };   // shorter recording (new URL dodges the 1h browser cache on the old file)
    const sound = TAUNT_VOICE[(m.playerId || '').toLowerCase()] || (ab.sounds ? pick(ab.sounds) : ab.sound);
    // Counts-only result (Josh 2026-07-04: "group them like other multi-target
    // spells" — nobody needs every enemy's save read out one by one).
    let pulled = 0, shrugged = 0;
    for (const e of this.livingEnemies()) {
      const sv = this._saveVs(this._enemySave(e, ab.save || 'will'), dc);
      if (!sv.saved) { e.taunted = m.playerId; pulled++; } else shrugged++;
    }
    this._note(`${ab.icon} ${m.nickname} bellows a furious challenge [Will DC ${dc}] — 📢 ${pulled} enraged and coming for ${m.nickname}${shrugged ? `, ${shrugged} shrug${shrugged === 1 ? 's' : ''} it off` : ''}.`, sound);
    this._echoToTable(sound);
  },
  // Smite Evil — your strikes smite evil foes this room.
  _abSmite(m, ab) {
    m.smiteActive = true;
    const sound = ab.sound || pick(SND.flesh);
    this._note(`${ab.icon} ${m.nickname} calls a Smite — righteous fury against evil this room!`, sound);
    this._echoToTable(sound);
  },
  // Detect Evil (paladin): a standard action that MARKS every living foe as evil
  // (sets markedEvil), so Smite Evil applies to ALL of them this room — including
  // the true-neutral ones (animals, constructs). Plays the "into the light" cue.
  _abDetectEvil(m, ab) {
    const foes = this.livingEnemies();
    let n = 0;
    for (const e of foes) { if (!e.markedEvil) { e.markedEvil = true; n++; } }
    const sound = ab.sound || '/audio/into_the_light.mp3';
    this._note(`${ab.icon || '🎯'} ${m.nickname} calls DETECT EVIL — the room floods with revealing light; ${n || foes.length} foe(s) MARKED for Smite!`, sound);
    this._echoToTable(sound);
  },
  // ── DOMAIN granted powers (DOMAINS-DESIGN.md §2) ───────────────────────────
  // Pool-limited actives (3+Wis/room via the normal room-uses pipeline). The
  // attack riders (_domStrike/_domSmite/_domBleed) are consumed by _swingVsAC /
  // _playerAttack on the hero's next attack action; the ward ticks down at the
  // hero's turn start; Good Fortune spends itself on the next missed swing.
  _abDomStrike(m, ab) {
    m._domStrike = Math.max(1, Math.floor((m.level || 1) / 2));
    this._note(`💪 ${m.nickname} SURGES with the Strength domain — +${m._domStrike} to hit and damage on their next attack!`, ab.sound);
    this._echoToTable(ab.sound); this._broadcast();
  },
  _abDomSmite(m, ab) {
    m._domSmite = m.level || 1;
    this._note(`⚔️ ${m.nickname} rouses BATTLE RAGE (War domain) — +${m._domSmite} damage on their next attack!`, ab.sound);
    this._echoToTable(ab.sound); this._broadcast();
  },
  _abDomFortune(m, ab) {
    m._domFortune = true;
    this._note(`🍀 ${m.nickname} courts GOOD FORTUNE (Luck domain) — their next missed attack will be rerolled.`, ab.sound);
    this._echoToTable(ab.sound); this._broadcast();
  },
  _abDomWard(m, ab, payload) {
    const t = (payload && payload.allyUid && this.member(payload.allyUid)) || m;
    t._domWardRounds = 3;
    this._note(`🛡️ ${m.nickname} lays a RESISTANT TOUCH (Protection domain) on ${t === m ? 'themself' : t.nickname} — +2 on all saves for 3 rounds.`, ab.sound);
    this._echoToTable(ab.sound); this._broadcast();
  },
  _abDomBleed(m, ab) {
    m._domBleed = true;
    this._note(`💀 ${m.nickname}'s hand darkens (Death domain) — their next hit will open a BLEEDING wound (1d6/round).`, ab.sound);
    this._echoToTable(ab.sound); this._broadcast();
  },
  // Trip: an ATTACK ROLL (no damage). On a hit the foe is knocked prone, LOSES
  // its turn, and you get an immediate free attack (prone = +4 for all to hit).
  // PF1 trip restrictions for a (Medium) hero tripping `e`. Returns a reason string
  // when the trip is IMPOSSIBLE, else null. Separately, _tripDefBonus is the foe's
  // extra trip defense: +4 per leg beyond two (a quadruped wolf is harder to sweep;
  // an 8-legged spider nearly impossible) + the PF1 special size modifier (+1 Large,
  // +2 Huge) for foes bigger than the tripper.
  _tripBlocked(e) {
    if (e.noTrip || (e.legs != null && e.legs === 0)) return `${e.name} has no legs to sweep`;
    if (e.flying) return `${e.name} is airborne, immune to prone`;
    if ((SIZE_RANK[e.size] || 0) > 1) return `${e.name} is ${SIZE_NAME[e.size] || 'too large'} — more than one size bigger than you`;   // PF1: can trip up to ONE size larger
    return null;
  },
  _tripDefBonus(e) {
    const legs = (e.legs != null ? e.legs : 2);
    return Math.max(0, (legs - 2)) * 4 + Math.max(0, SIZE_RANK[e.size] || 0);
  },
  _abTrip(m, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    const blocked = this._tripBlocked(e);
    if (blocked) { this._note(`${m.nickname} can't trip ${e.name} — ${blocked}.`); return this._echoToTable(); }
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const tripDef = this._tripDefBonus(e);
    const a = this._attackRoll(m, e, tripDef);   // extra legs + size raise the bar (PF1 CMD vs trip)
    const defTag = tripDef > 0 ? ` (+${tripDef} ${e.legs > 2 ? `${e.legs}-legged ` : ''}${(SIZE_RANK[e.size] || 0) > 0 ? SIZE_NAME[e.size] + ' ' : ''}stability)` : '';
    if (!a.hit) { this._note(`🦵 ${m.nickname} tries to trip ${e.name} but it keeps its footing${defTag}. [d20 ${a.roll} ${this._fmtBonus(a.toHit)} = ${a.total} vs ${this._enemyAC(e) + tripDef}]`, a.weapon.isDagger ? SND.whiffDagger : pick(SND.whiffSword)); return this._echoToTable(); }
    e.prone = true; e.loseTurn = true;
    this._note(`🦵 ${m.nickname} TRIPS ${e.name} prone${defTag} — it loses its turn! Free attack!`);
    const r = this._swingVsAC(m, this._enemyAC(e), e);   // prone (−4 AC) folded into _enemyAC
    if (r.hit) { this._dmgE(e, r.damage); this._note(`⚔️ free hit on ${e.name} for ${r.damage}${r.drTag || ''}.${this._afterEnemyHit(e)}`, r.sound); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    else this._note(`⚔️ the free hit misses. ${this._atkStr(r)}`, r.sound);
    this._echoToTable(r.sound);
  },
  // Disarm (swashbuckler): an opposed maneuver (the duelist's combat roll vs the
  // foe's CMD). On a success the foe loses its next turn scrambling for its weapon
  // and the swashbuckler lands a free strike.
  _abDisarm(m, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    if (fightsNatural(e)) { this._note(`🌀 ${m.nickname} can't disarm ${e.name} — it fights with natural weapons (claws, fangs, fists); nothing to knock away.`); return this._echoToTable(); }
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const cmb = dRoll(20) + babFor(m.cls || 'swashbuckler', m.level || 1) + ABILITY_MOD + ((m.buffs && m.buffs.toHit) || 0) + this._hasteMod(m);
    const cmd = 10 + (e.toHit || 0);   // rough CMD from the foe's offense (scales with CR via toHit)
    if (cmb < cmd) { this._note(`🌀 ${m.nickname} lunges to disarm ${e.name}, but it keeps its grip. [${cmb} vs CMD ${cmd}]`, pick(SND.whiffSword)); return this._echoToTable(); }
    e.loseTurn = true;
    this._note(`🌀 ${m.nickname} DISARMS ${e.name}! [${cmb} vs CMD ${cmd}] — it scrambles for its weapon (loses its next turn) — free strike!`);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    if (r.hit) { this._dmgE(e, r.damage); this._note(`🗡️ ${m.nickname} skewers the off-balance ${e.name} for ${r.damage}${r.drTag || ''}.${this._afterEnemyHit(e)}`, r.sound); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    else this._note(`🗡️ the follow-up misses ${e.name}. ${this._atkStr(r)}`, r.sound);
    this._echoToTable(r.sound);
  },
  // ── PF1 COMBAT MANEUVERS (shared math) ──────────────────────────────────────
  // CMB = d20 + BAB + STR mod + the same situational hit mods a swing gets (buffs
  // incl. Power Attack / Fight Defensively penalties, Haste). Real STR from the
  // individualized build, falling back to the legacy +4 when a member has no mods.
  // HOMERULE: a maneuver may be powered by DEX instead of STR when DEX is higher —
  // so nimble, low-STR heroes (rogues, swashbucklers, monks) are just as good at
  // combat maneuvers as bruisers. Used for the STR term of CMB.
  _mnvMod(m) {
    const str = (m.mods && m.mods.str != null) ? m.mods.str : ABILITY_MOD;
    const dex = (m.mods && m.mods.dex != null) ? m.mods.dex : 0;
    return Math.max(str, dex);
  },
  _heroCMB(m) {
    return dRoll(20) + babFor(m.cls || 'fighter', m.level || 1)
         + this._mnvMod(m)                            // DEX-or-STR (homerule)
         + ((m.buffs && m.buffs.toHit) || 0) + this._hasteMod(m);
  },
  // A hero's CMD (10 + BAB + STR + DEX) — what a grappled foe rolls against to slip
  // free. RAW already sums both stats, so a high-DEX hero already defends well.
  _heroCMD(m) {
    return 10 + babFor(m.cls || 'fighter', m.level || 1)
         + ((m.mods && m.mods.str != null) ? m.mods.str : ABILITY_MOD)
         + ((m.mods && m.mods.dex != null) ? m.mods.dex : 0);
  },
  // A foe's CMD vs a maneuver: its offense (toHit ≈ BAB+STR) over 10, plus, for
  // moves that try to upend/move/seize it, stability from extra legs + big size.
  _enemyCMD(e, stability) { return 10 + (e.toHit || 0) + (stability ? this._tripDefBonus(e) : 0); },
  // Bull Rush (STR maneuver): shove the foe back. On a success it's driven out of
  // reach and loses its next turn recovering ground; a hard shove (≥5 over its CMD)
  // slams it prone. No free attack — you've pushed it AWAY, not set it up.
  _abBullRush(m, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const cmb = this._heroCMB(m), cmd = this._enemyCMD(e, true);
    if (cmb < cmd) { this._note(`💪 ${m.nickname} throws a shoulder into ${e.name}, but it holds its ground. [CMB ${cmb} vs CMD ${cmd}]`, pick(SND.whiffSword)); return this._echoToTable(); }
    e.loseTurn = true;
    const hard = cmb - cmd >= 5;
    if (hard) e.prone = true;
    this._note(`💪 ${m.nickname} BULL RUSHES ${e.name}${hard ? ' — a brutal shove that SLAMS it prone' : ''} — driven back, it loses its turn closing the distance! [CMB ${cmb} vs CMD ${cmd}]`, '/audio/spell_revive.mp3');
    this._echoToTable('/audio/spell_revive.mp3');
  },
  // Grapple (STR maneuver): seize the foe. On a success it's grappled & helpless —
  // it burns its turns struggling (the enemy-turn escape loop rolls its CMB vs the
  // grappler's CMD; the grip lasts ~2 rounds) — and the grab crushes for a free
  // strike. Can't grapple foes far bigger than the grappler or incorporeal ones.
  _abGrapple(m, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    if (e.grappled) { this._note(`🤼 ${e.name} is already grappled.`); return this._echoToTable(); }
    if (e.incorporeal) { this._note(`🤼 ${m.nickname} can't grapple ${e.name} — it's incorporeal, hands pass right through.`); return this._echoToTable(); }
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const cmb = this._heroCMB(m), cmd = this._enemyCMD(e, true);
    if (cmb < cmd) { this._note(`🤼 ${m.nickname} grabs at ${e.name}, but it twists out of the hold. [CMB ${cmb} vs CMD ${cmd}]`, pick(SND.whiffSword)); return this._echoToTable(); }
    e.grappled = true; e.grappledBy = m.playerId; e.grappleRounds = 2;   // helpless until it breaks free (enemy-turn escape) or ~2 rounds pass
    this._note(`🤼 ${m.nickname} GRAPPLES ${e.name} — seized and helpless, it'll burn its turns struggling free! [CMB ${cmb} vs CMD ${cmd}] Free strike!`, '/audio/spell_revive.mp3');
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    if (r.hit) { this._dmgE(e, r.damage); this._note(`💥 ${m.nickname} crushes the held ${e.name} for ${r.damage}${r.drTag || ''}.${this._afterEnemyHit(e)}`, r.sound); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    else this._note(`💥 the crushing grip can't land clean. ${this._atkStr(r)}`, r.sound);
    this._echoToTable(r.sound);
  },
  // Spiritual Weapon (cleric): conjure a force-blade over a chosen foe. It strikes
  // that foe on EACH of the cleric's turns — see _spiritWeaponStrike, fired from
  // _advanceToActor — so the cleric can do other things while it fights on. Lasts
  // 1 round per ½ caster level, and it swings the moment it's summoned.
  // A divine caster's SPIRITUAL WEAPON takes the shape of their GOD's favored
  // weapon: Besmara's rapier (Rhyarca), Sarenrae's scimitar (Elfrip), Brigh's
  // multitool (Dinvaya — closest staple: battleaxe), Vesorianna's lash (whip).
  // Everyone else conjures a force-copy of their own weapon, as before.
  _spiritWeaponKey(m) {
    const BY_CHAR = { rhyarca: 'rapier', elfrip: 'scimitar', dinvaya: 'battleaxe', vesorianna: 'whip' };
    return BY_CHAR[(m.playerId || '').toLowerCase()] || m.weaponKey;
  },
  _abSpiritWeapon(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    const rounds = Math.max(1, Math.floor((m.level || 1) / 2));   // 1 round per 2 caster levels
    m.spiritWeapon = { targetUid: e.uid, rounds };
    const shape = weaponOf({}, this._spiritWeaponKey(m)).name.replace(/^Masterwork /, '');
    this._note(`🗡️✨ ${m.nickname} conjures a SPIRITUAL ${shape.toUpperCase()} over ${e.name} — it will strike on every turn for ${rounds} rounds!`, ab.sound || '/audio/spell_holy_smite.mp3');
    this._echoToTable(ab.sound || '/audio/spell_holy_smite.mp3');
    this._spiritWeaponStrike(m);   // it lashes out the instant it appears
  },
  // One round of the spiritual weapon's attacks. It uses the cleric's weapon and
  // ALL their combat math (buffs, feats, Prayer/Bless/Divine Favor) via _swingVsAC,
  // and gets an extra swing while the cleric is Hasted. Re-targets if its foe dies,
  // so the blade keeps fighting until its duration runs out.
  // When a spiritual weapon outlives its target it re-acquires (Tobias). It's a
  // FORCE blade — no reach problem — so it PREFERS airborne foes the party's melee
  // can't touch, then the MOST DANGEROUS of those (boss > caster > CR/threat),
  // rather than mopping up the weakest. Falls back to the deadliest grounded foe
  // when nothing's flying.
  _spiritTarget() {
    const foes = this._targetableEnemies();   // never re-acquire onto a summoned ally
    if (!foes.length) return null;
    const flyers = foes.filter(e => e.flying);
    const pool = flyers.length ? flyers : foes;
    const threat = (e) => (e.boss ? 100 : 0)
      + ((e.arcane || e.healer || e.caster || e.spellstrike) ? 30 : 0)
      + (crToNum(e.cr) || 0) * 4 + (e.toHit || 0);
    return pool.slice().sort((a, b) => threat(b) - threat(a))[0];
  },
  _spiritWeaponStrike(m) {
    const sw = m.spiritWeapon; if (!sw) return;
    sw.rounds -= 1;
    let e = this.enemies.find(x => x.uid === sw.targetUid && x.hp > 0);
    if (!e) {
      e = this._spiritTarget();
      if (e) { sw.targetUid = e.uid; this._note(`🗡️✨ ${m.nickname}'s Spiritual Weapon seeks a new mark — ${e.name}${e.flying ? ' on the wing' : ''}!`); }
    }
    if (e) {
      m.weapon = weaponOf(m.gear, this._spiritWeaponKey(m));   // the god's weapon, riding the caster's enhancement
      const swings = 1 + (m.hasted > 0 ? 1 : 0);   // benefits from Haste — an extra strike
      const snd = '/audio/spell_holy_smite.mp3';    // its own ringing note
      const parts = [];
      for (let i = 0; i < swings && e.hp > 0; i++) {
        const r = this._swingVsAC(m, this._enemyAC(e), e);
        if (r.hit) { this._dmgE(e, r.damage); parts.push(`${r.crit ? 'CRIT ' : ''}${r.damage}`); }
        else parts.push('miss');
      }
      this._note(`🗡️✨ ${m.nickname}'s Spiritual Weapon strikes ${e.name} — ${parts.join(', ')}.${this._afterEnemyHit(e)} (${sw.rounds} rd left)`, snd);
      this._echoToTable(snd);
      if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name });
    }
    if (sw.rounds <= 0) { m.spiritWeapon = null; this._note(`🗡️✨ ${m.nickname}'s Spiritual Weapon dissolves into motes of light.`); }
    this._broadcast();
  },
  // Cleave: hit the target; then swing at a second foe (−2). A barbarian's
  // cleave (ab.acPen) also drops their guard −2 AC until their next turn.
  _abCleave(m, ab, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    this._cleaveSweep(m, e, { followThrough: true, acPen: ab && ab.acPen });
  },
  // A random living foe not already struck this sweep (chain cleaves jump around).
  _randomLivingFoe(exclude) {
    const pool = this.livingEnemies().filter(x => !exclude.has(x.uid) && !x.summoned);   // never chain onto a summoned ally
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  },
  // Play ONE report for the whole cleave sweep — a chain shouldn't machine-gun a
  // sound per swing (too noisy). The notes carry no log sound, so this is the
  // single sound the dungeon (clear) and the table (muffled echo) hear.
  _emitChainSfx(sounds) {
    const snd = sounds.find(Boolean);
    if (!snd || !this.io) return;
    try {
      this.io.to(this.roomName()).emit('dungeon:sfx', { sound: snd });
      this.io.to(`table:${this.tableId}`).emit('dungeon:echo', { sound: snd });
    } catch (_) {}
  },
  // Cleave / Great Cleave sweep — shared by the Cleave ability AND any barbarian
  // attack. Swings at firstTarget (the player-chosen foe); with `followThrough`
  // the Cleave ability always gets one extra swing after a connecting hit; ANY
  // swing that DROPS a foe chains onto a RANDOM fresh enemy, continuing while it
  // keeps felling them. Each swing's attack sound is queued (staggered) so the
  // chain is audible; the notes themselves carry no sound to avoid a double-play.
  _cleaveSweep(m, firstTarget, opts = {}) {
    const forced = this._forcedFoe(m);   // taunted → the FIRST cleave is dragged onto the taunter (chains stay random)
    if (forced) firstTarget = forced;
    m.flatFooted = false; m.invisible = false;
    if (opts.acPen) { m.acPenRound = this.round; m.acPenAmt = opts.acPen; }
    m.weapon = weaponOf(m.gear, m.weaponKey);
    // A cleave can only sweep through foes the blade can REACH — if the chosen
    // target is airborne, redirect to a grounded foe; if EVERYTHING flies, hand
    // the turn to the normal attack (its backup crossbow can at least shoot).
    if (!this._canReach(m, firstTarget)) {
      const grounded = this.livingEnemies().filter(x => !x.summoned && this._canReach(m, x));
      if (!grounded.length) return this._playerAttack(m, firstTarget.uid);
      firstTarget = pick(grounded);
    }
    const baseSound = (m.cls === 'monk' && !m.weapon.atkSound) ? pick(MONK_SFX) : (m.weapon.atkSound || (m.weapon.dtype === 'B' ? '/audio/weapon_blunt.mp3' : null));   // monks alternate bruce/punisher/bamboo per swing (Tobias 2026-07-04)
    const struck = new Set();
    const sounds = [];
    let target = firstTarget, bonus = false, kills = 0;
    const MAX = 24;   // safety cap so a freak run can't loop forever
    // The whole sweep reports as ONE line — "Josh cleaves — Skeleton 35 ☠️, Zombie
    // 28 ☠️, Shadow miss. 2 foes felled!" — instead of a line per swing (a 9-kill
    // Great Cleave used to flood 10+ lines and trip the blind narrator's cap).
    const bits = [];
    for (let swings = 0; target && swings < MAX; swings++) {
      struck.add(target.uid);
      const r = this._swingVsAC(m, this._enemyAC(target) + (bonus ? 2 : 0), target);
      sounds.push(baseSound || r.sound || null);
      let downed = false;
      if (r.fumble) {
        bits.push(`${target.name} FUMBLE`);
      } else if (r.hit) {
        this._dmgE(target, r.damage); downed = target.hp <= 0;
        bits.push(`${target.name} ${r.damage}${r.drTag || ''}${this._afterEnemyHit(target)}`);   // _afterEnemyHit already adds ☠️ or (hp/max) — don't print the total twice (Josh: "66 of 95 66 of 95")
        if (downed) { kills++; this._tryBanter(m, 'down', { enemy: target.name }); }
      } else {
        bits.push(`${target.name} miss`);
      }
      // Continue if this swing FELLED a foe (Great Cleave chain), or — once — to
      // grant the Cleave ability's standard follow-through after a connecting hit.
      const keepGoing = downed || (opts.followThrough && r.hit && !bonus);
      bonus = true;
      if (!keepGoing) break;
      // 2nd + chain targets are RANDOM — but only foes the blade can REACH
      // (a Great Cleave never chains up into a flyer).
      const pool = this.livingEnemies().filter(x => !x.summoned && !struck.has(x.uid) && this._canReach(m, x));   // chains sweep foes only, never summoned allies
      target = pool.length ? pick(pool) : null;
    }
    if (bits.length) this._note(`🪓 ${m.nickname} cleaves — ${bits.join(', ')}.${kills >= 3 ? ` ${kills} foes felled in one furious sweep!` : ''}`, null);
    this._emitChainSfx(sounds);
  },
  // Feint: an opposed roll. On success the foe is flat-footed → a free
  // Sneak-Attack strike (the rogue's Sneak Attack rides on the denied defense).
  _abFeint(m, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    const bluff = dRoll(20) + (m.level || 1) + ABILITY_MOD;
    const sense = dRoll(20) + (e.toHit || 0);
    if (bluff < sense) { this._note(`🎭 ${m.nickname} feints ${e.name}, but it doesn't bite. [${bluff} vs ${sense}]`, pick(SND.whiffSword)); return this._echoToTable(); }
    e.flatFooted = true;
    this._note(`🎭 ${m.nickname} feints ${e.name} flat-footed! [${bluff} vs ${sense}] — free strike!`);
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    const tag = r.sneakDice ? ` (+${r.sneakDmg} sneak)` : '';
    if (r.hit) { this._dmgE(e, r.damage); this._note(`🗡️ ${m.nickname} strikes ${e.name} for ${r.damage}${r.drTag || ''}.${tag}${this._afterEnemyHit(e)}`, r.sound); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    else this._note(`🗡️ the strike misses ${e.name}. ${this._atkStr(r)}`, r.sound);
    this._echoToTable(r.sound);
  },
  // Reckless Blow: +4 damage this swing, but −4 AC until your next turn.
  _abReckless(m, payload) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.acPenRound = this.round; m.acPenAmt = 4;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e), e);
    if (r.hit) { const dmg = r.damage + 4; this._dmgE(e, dmg); this._note(`💥 ${m.nickname} swings recklessly at ${e.name} for ${dmg}! (guard dropped)${this._afterEnemyHit(e)}`, r.sound); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    else this._note(`💥 ${m.nickname}'s reckless swing misses ${e.name}. ${this._atkStr(r)}`, r.sound);
    this._echoToTable(r.sound);
  },

  // One ranged shot at a to-hit modifier (rangers). The WEAPON's signature report
  // wins (so a rifle cracks like a rifle — e.g. Duristan's bolt-action Lapua);
  // the ability's generic bow sound is only the fallback for a plain bow.
  _bowShot(m, ab, payload, hitMod, label) {
    const e = this._oneEnemy(payload); if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    const r = this._swingVsAC(m, this._enemyAC(e, { touch: m.weapon.group === 'firearms' }), e, hitMod);   // firearms hit vs touch AC
    if (m.weapon.atkSound) r.sound = m.weapon.atkSound; else if (ab.sound) r.sound = ab.sound;
    if (r.hit) { this._dmgE(e, r.damage); this._note(`${ab.icon} ${m.nickname}${label} ${r.crit ? 'CRITS' : 'hits'} ${e.name} for ${r.damage}${r.drTag || ''}. ${this._atkStr(r)}${this._afterEnemyHit(e)}`, r.sound); if (e.hp <= 0) this._tryBanter(m, 'down', { enemy: e.name }); }
    else this._note(`${ab.icon} ${m.nickname}${label} misses ${e.name}. ${this._atkStr(r)}`, r.sound);
    this._echoToTable(r.sound);
  },
  // Rapid Shot: two arrows this turn, each at −2.
  _abRapidShot(m, ab, payload) {
    // A bolt-action sniper rifle can't fire twice — fall back to a single shot.
    if (weaponOf(m.gear, m.weaponKey).boltAction) { this._bowShot(m, ab, payload, 0, ''); return; }
    this._bowShot(m, ab, payload, -2, ' (rapid 1)');
    this._bowShot(m, ab, payload, -2, ' (rapid 2)');
  },
  // Bullseye Shot: one carefully-aimed arrow at +4.
  _abBullseye(m, ab, payload) {
    this._bowShot(m, ab, payload, 4, ' takes aim and');
  },

  // At-will attack. Rogues with daggers strike TWICE (two-weapon style); a rogue
  // with any other weapon strikes once. Sneak Attack applies via _swingVsAC.
  // Per-swing to-hit OFFSETS for a hero's basic attack. A standard attack on a
  // NEW target is a single swing (a dual-wielder still gets their off-hand). On a
  // FULL attack — staying on the SAME target as last turn — every martial adds PF1
  // iteratives (−5/−10/−15 as BAB reaches 6/11/16), and a dual-wielder adds their
  // Two-Weapon Fighting / Improved Two-Weapon Fighting off-hand swing. The TWF
  // penalty (−6, or −2 with the Two-Weapon Fighting feat) rides on every swing.
  _attackOffsets(m, e) {
    const bab = babFor(m.cls || 'fighter', m.level || 1);
    const ff = fighterFeats(m.cls, m.level, this._isRanged(m));
    // Natural multi-attackers (Crisp the deinonychus: bite + 2 talons) make their
    // FULL natural routine every turn — Pounce-style, even on a fresh target — all
    // at full BAB. No iteratives/TWF on top.
    if (m.weapon && m.weapon.naturalAttacks > 1) return Array(m.weapon.naturalAttacks).fill(0).map(off => ({ off, oh: false }));
    const dual = this._isDualWielding(m);
    // RANGED attackers (bows, crossbows, guns) can ALWAYS full-attack — they don't
    // move to reach a foe. MELEE only get their iteratives when they stay on the SAME
    // target as last turn (a proxy for not having to charge/move to a new one).
    const isRanged = !!(m.weapon && m.weapon.ranged);
    const fullAttack = isRanged || (m._lastAtkTarget === e.uid);
    // RAPID SHOT (feat, ranged ladder g3): one extra shot on a full attack, at −2 to
    // ALL shots this turn (PF1). Bolt-action rifles can't cycle that fast. Manyshot
    // (g12, BOWS only) nocks a 2nd arrow on the first shot — an extra arrow at FULL BAB.
    const rapidOn = isRanged && fullAttack && ff.rapidShot && !(m.weapon && m.weapon.boltAction);
    const twfPen = (dual ? (ff.twf ? -2 : -6) : 0) + (rapidOn ? -2 : 0);
    // Each swing carries `oh` (off-hand) → ½ ability mod to damage (PF1). Only the
    // SECOND weapon's swings are off-hand; main-hand iteratives and ranged extras
    // are full-mod.
    const off = [{ off: twfPen, oh: false }];                  // primary / main-hand swing
    if (dual) off.push({ off: twfPen, oh: true });             // base off-hand swing (the 2nd weapon)
    if (rapidOn) off.push({ off: twfPen, oh: false });         // Rapid Shot's extra shot (full BAB, −2 like the rest)
    if (isRanged && fullAttack && ff.manyshot && m.weapon && m.weapon.group === 'bows') off.push({ off: twfPen, oh: false });   // Manyshot's 2nd arrow
    if (fullAttack) {
      if (bab >= 6)  off.push({ off: twfPen - 5,  oh: false });   // main-hand iterative
      if (bab >= 11) off.push({ off: twfPen - 10, oh: false });
      if (bab >= 16) off.push({ off: twfPen - 15, oh: false });
      if (dual && ff.itwf && bab >= 6) off.push({ off: twfPen - 5, oh: true });   // Improved Two-Weapon Fighting (2nd off-hand swing)
    }
    return off;
  },
  _playerAttack(m, targetUid, quiet = false, opts = {}) {
    m.flatFooted = false;   // acting ends flat-footed
    if (!quiet) m._offDef = false;   // Offensive Defense lasts until the rogue next acts
    if (!m.greaterInvis) m.invisible = false;    // attacking breaks Invisibility (Greater persists)
    const e = this.enemies.find(x => x.uid === targetUid && x.hp > 0) || this.livingEnemies()[0];
    if (!e) return;
    m.weapon = weaponOf(m.gear, m.weaponKey);
    if (e.darkened > 0) { this._note(`🌑 ${m.nickname} can't find ${e.name} in the magical darkness!`); this._broadcast(); return; }
    // Melee can't reach a flyer. Rather than waste the turn, a melee character draws
    // their BACKUP ranged weapon and shoots — the generic masterwork light crossbow
    // for most (plain, so always worse than the real weapon), or a SIGNATURE sidearm
    // for the gunfighters: El Guapo's pistol and Gaspar's paired pistols (firearms —
    // TOUCH AC, and they ride the wielder's weapon enchant + every buff/Bane).
    // A flyer-reaching hero (Overland Flight magus) just melees as normal.
    const _realWeapon = m.weapon;
    // GASPAR's 60/40: facing a MIXED field (flyers AND grounded), bot Gaspar draws
    // the paired pistols 40% of the time — bane-boosted touch-AC full attacks at
    // whatever he's targeting — and works the Curator the other 60%.
    let forceRanged = !!(opts && opts.forceRanged && !m.weapon.ranged);   // the Ranged button: a melee martial draws the backup crossbow / sidearm (a real ranged weapon just shoots normally)
    if (!quiet && m.isBot && (m.playerId || '').toLowerCase() === 'gaspar' && !m.weapon.ranged) {
      const foes = this._targetableEnemies();
      if (foes.some(f => f.flying) && foes.some(f => !f.flying) && dRoll(10) <= 4) forceRanged = true;
    }
    let drewCrossbow = false;
    if (forceRanged || (e.flying && !m.weapon.ranged && !m.weapon.reachFly && !(m.canHitFlyers && m.flying))) {
      const bk = this._backupRangedKey(m);
      m.weapon = weaponOf(bk === 'lightcrossbow' ? {} : m.gear, bk);   // signature sidearms keep the wielder's enchant; the generic crossbow stays plain
      // The improvised LIGHT CROSSBOW fires a SINGLE shot — PF1: a crossbow can't
      // full-attack without Rapid Reload/Crossbow Mastery, so no iterative volley up
      // at a flyer (Josh: "my primary can't hit a flyer but my secondary and tertiary
      // can"). Signature SIDEARMS (Gaspar's/El Guapo's guns) keep their full volley.
      if (bk === 'lightcrossbow') drewCrossbow = true;
      if (!quiet) this._note(`🔫 ${m.nickname} ${forceRanged ? 'draws' : `can't reach the airborne ${e.name} in melee — draws`} ${bk === 'lightcrossbow' ? 'a light crossbow' : (bk === 'gasparpistols' ? 'his paired pistols' : 'his pistol')}!`);
    }
    // Build the swing sequence as a list of to-hit OFFSETS (see _attackOffsets):
    // dual-wielders attack twice; staying on the same target adds PF1 iteratives.
    // A Haste bonus swing (quiet) — or an improvised crossbow — is a single strike.
    const offsets = (quiet || drewCrossbow || m.slowed > 0) ? [{ off: 0, oh: false }] : this._attackOffsets(m, e);   // slowed/staggered → a SINGLE attack, no full-attack iteratives (PF1)
    if (!quiet) m._lastAtkTarget = e.uid;   // remember the target → next turn's full-attack check
    const swings = offsets.length;
    // Sound: signature atkSound > a blunt "bap" for B-type weapons (quarterstaff,
    // warhammer…) > the swing's own hit/whiff. Plays ONCE for the whole flurry.
    let baseSound = (m.cls === 'monk' && !m.weapon.atkSound) ? pick(MONK_SFX) : (m.weapon.atkSound || (m.weapon.dtype === 'B' ? '/audio/weapon_blunt.mp3' : null));   // monks alternate bruce/punisher/bamboo per swing (Tobias 2026-07-04)
    if (m.smiteActive && m.weaponKey === 'warhammer') baseSound = '/audio/weapon_warhammer_smite.mp3';   // holy hammer-ring on a smite
    // MULTI-SWING flurries collapse into ONE line — "Josh attacks Lich: 35, CRIT 62,
    // miss — Slain!" — instead of a name-prefixed line per swing (Josh's TTS report).
    // Single swings (and the Haste bonus strike) keep the classic one-liner with roll detail.
    const multi = swings > 1;
    const groups = [];   // consecutive same-target swings → one segment each
    let flurrySound = null;
    let landed = false;   // did ANY swing connect this action? (Radiance roasts a total whiff)
    for (let i = 0; i < swings; i++) {
      // Resolve swings ONE AT A TIME: if the target has dropped, the next swing
      // redirects to another foe (PF1 — you don't pre-commit a full attack) —
      // but only one this weapon can REACH (no melee iteratives up at flyers;
      // a backup crossbow, being ranged, redirects freely).
      const tgt = (e.hp > 0) ? e : this._targetableEnemies().find(x => this._canReach(m, x));
      if (!tgt) break;
      const r = this._swingVsAC(m, this._enemyAC(tgt, { touch: m.weapon.group === 'firearms', ranged: !!m.weapon.ranged }), tgt, offsets[i].off, offsets[i].oh);   // firearms hit vs touch AC; ranged flag drives prone ±4; offset = iterative/TWF penalty; oh = off-hand (½ mod)
      if (i > 0 || quiet) r.sound = null;            // one report for the whole flurry; haste swing silent
      else if (baseSound) r.sound = baseSound;       // signature / blunt report on the first swing
      // Rogue Sneak Attack with a light blade (dagger/kukri/shortsword) → Riki.
      if (r.sneakDice && isSneakClass(m.cls) && ['dagger', 'kukri', 'shortsword'].includes(m.weaponKey) && i === 0) r.sound = '/audio/sneak_riki.mp3';
      if (i === 0) flurrySound = r.sound;
      const tag = (r.smite ? ' ⚔️Smite!' : '') + (r.sneakDice ? ` (+${r.sneakDmg} sneak)` : '');
      if (!multi) {
        if (r.fumble) this._note(`${m.nickname} fumbles the attack! ${this._atkStr(r)}`, r.sound);
        else if (r.hit) { this._dmgE(tgt, r.damage); this._note(`${m.nickname} ${r.crit ? 'CRITS' : 'hits'} ${tgt.name} for ${r.damage}${r.drTag || ''}.${tag} ${this._atkStr(r)}${tgt.hp <= 0 ? ' ☠️ Slain!' : ''}`, r.sound); }
        else this._note(`${m.nickname} misses ${tgt.name}. ${this._atkStr(r)}`, r.sound);
      } else {
        let g = groups[groups.length - 1];
        if (!g || g.tgt !== tgt) { g = { tgt, bits: [] }; groups.push(g); }
        if (r.fumble) g.bits.push('FUMBLE');
        else if (r.hit) { this._dmgE(tgt, r.damage); g.bits.push(`${r.crit ? 'CRIT ' : ''}${r.damage}${r.drTag || ''}${tag}`); }
        else g.bits.push('miss');
      }
      if (r.hit) {
        landed = true;
        if (r.crit) this._dauntingSuccess(m);   // Order of the Flame (L8): a confirmed crit daunts the room
        // Rogue Offensive Defense (feat tree n8): landing a sneak attack grants +2 AC
        // until they next act — the strike leaves the foe off-balance.
        if (r.sneakDice && fighterFeats(m.cls, m.level, this._isRanged(m)).offDef && !m._offDef) { m._offDef = true; this._note(`🤸 ${m.nickname}'s strike leaves them covered — +2 AC until their next move (Offensive Defense).`); }
        // Promethean tentacles GRAB on a hit — the foe is grappled & helpless until it breaks free.
        if (m.weapon.grapple && tgt.hp > 0 && !tgt.grappled) { tgt.grappled = true; tgt.grappledBy = m.playerId; tgt.grappleRounds = 2; this._note(`🐙 ${tgt.name} is SEIZED in ${m.nickname}'s tentacles — grappled and helpless!`); }
        if (tgt.hp <= 0) this._tryBanter(m, 'down', { enemy: tgt.name });
        if (tgt.hp <= 0 && tgt.type === 'undead') this._radianceQuip(m, 'radiance_undead_down', { enemy: tgt.name });   // Radiance HATES undead — she erupts
        // TON BOKIRI: the demon spear drinks a kill and floods its wielder with a barbarian rage.
        if (tgt.hp <= 0 && m.weaponKey === 'tonbokiri' && !(m.buffApplied && m.buffApplied.rage)) { this._abBuff(m, { key: 'rage', effect: 'buff', target: 'self' }); this._note(`🗡️ Ton Bokiri drinks the kill — "KUROSE!" — flooding ${m.nickname} with a DEMONIC RAGE.`); }
      }
      this._echoToTable(r.sound);
    }
    if (multi && groups.length) {
      const txt = groups.map(g => `${g.tgt.name}: ${g.bits.join(', ')}${g.tgt.hp <= 0 ? ' ☠️ Slain!' : ''}`).join('; ');
      this._note(`⚔️ ${m.nickname} attacks — ${txt}`, flurrySound);
    }
    if (!landed && !quiet) this._radianceQuip(m, 'radiance_miss');   // the whole attack whiffed → Radiance: "Oops."
    m._domStrike = 0; m._domSmite = 0;   // Strength Surge / Battle Rage last ONE attack action — spent now, hit or miss
    m.weapon = _realWeapon;   // drop any backup crossbow — restore the real weapon for later reads (e.g. next turn's target pick)
  },
});
