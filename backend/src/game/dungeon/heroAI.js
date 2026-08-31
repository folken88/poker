/**
 * game/dungeon/heroAI.js — the HERO-BOT BRAIN: everything an AI ALLY decides on
 * its turn — the mirror of enemyAI.js (the villain brain). Factory mixin on
 * Dungeon.prototype:
 *   _allyAct       — the bot's turn (taunt/invis/heal/buff/ability/attack triage)
 *   _botAbility    — the big ability-choice decision tree (offense/support scoring)
 *   _botStance     — free-toggle picks (Power Attack / Deadly Aim / Fight Defensively)
 *   _preferredFoe / _sneakPrey / _forcedFoe — target selection
 *   _drBlocksWeapon — "does this foe's DR blank my weapon?" (bot weapon-swap check)
 * Cross-calls Dungeon core + the abilities/enemyAI mixins freely via `this`
 * (split ≠ decoupled). Factory takes { ABILITY_MOD, mindImmune, fightsNatural,
 * isSneakClass, ccd } (Dungeon module consts/predicates). Depends on: game/combat
 * (weaponOf/pick), game/character (attackProfile), pf1data classes/abilities/
 * monsters/feats. 2026-07-07: extracted VERBATIM from Dungeon.js (heroAI seam).
 */
const { weaponOf, pick } = require('../combat');
const { babFor } = require('../../pf1data/classes');
const { kitFor } = require('../../pf1data/abilities');
const { attackProfile } = require('../character');
const { crToNum } = require('../../pf1data/monsters');
const { fighterFeats } = require('../../pf1data/feats');

// v3.37.107: the classes whose basic attack is a CANTRIP, not a weapon — the
// population the self-preservation guard (total defense at <35% HP) applies to.
// Martials and hybrid sword-casters are excluded on purpose: their basic attack
// is real damage, and standing to swing IS their self-preservation.
const PURE_CASTERS = new Set(['wizard', 'sorcerer', 'cleric', 'oracle', 'druid', 'witch', 'theurge', 'necromancer', 'arcanist']);

module.exports = ({ ABILITY_MOD, mindImmune, fightsNatural, isSneakClass, ccd }) => ({
  // A living foe this member is compelled (taunted) to attack, or null.
  _forcedFoe(m) {
    if (!m || !m.tauntedBy) return null;
    return this.enemies.find(x => x.uid === m.tauntedBy && x.hp > 0) || null;
  },
  _allyAct(m) {
    const foes = this._targetableEnemies();   // can't target Darkness-shrouded foes
    if (!foes.length) return;
    m._unseenStrike = false;   // reset the unseen-opening-strike flag each turn (set only when a hidden hero breaks cover to attack)
    m._totalDefense = false;   // v3.37.107: last turn's TOTAL DEFENSE guard ends the moment they act again (PF1)
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
        m._unseenStrike = true;   // the opening blow lands before invisibility breaks — the prey is unseen (denied its Dex)
        this._basicAttack(m, prey.uid);
        this._hasteBonus(m);
        return;
      }
      // GREATER Invisibility does NOT break on attack, so a greater-invisible
      // ally fights normally (Josh: a greater-invis'd fighter just stood there
      // doing nothing). Fall through to the normal turn below; every swing lands
      // against a foe denied its Dex (see the greaterInvis branch in _denied).
      if (!m.greaterInvis) {
        // While hidden, FIRST prefer a support action that keeps the hero unseen AND
        // helps (heal/buff an ally) — free value, no reason to drop the veil. But NEVER
        // just turtle: if there's nothing useful to do hidden, BREAK COVER AND FIGHT.
        // (Josh: Femmik the bard and Savage the bloodrager sat invisible & idle for whole
        // rooms — at 80-90% HP — while the party got mauled. A hero with a weapon should
        // stab a motherfucker, not hide in the corner "for the right moment" that never
        // comes.) The breaking strike catches the foe unseen, so it denies its Dex.
        const c = this._botAbility(m);
        if (c && !c.guard) {   // guard sentinel is meaningless while unseen — fall through
          const ab = this._abilitiesFor(m)[c.slot];
          if (ab && ab.target !== 'enemy' && ab.target !== 'aoe' && ab.effect !== 'attack') {
            const r = this._useAbility(m, c.slot, c.payload);
            if (r && r.ok && ab) m._lastAbilityKey = ab.key;
            if (r && r.ok && !r.freeAction) { this._hasteBonus(m); return; }
          }
        }
        this._note(`🗡️ ${m.nickname} bursts from hiding to strike!`);
        m._unseenStrike = true;   // opening blow out of invisibility denies the target its Dex
        // fall through to the normal turn below — the attack breaks Invisibility, as it should.
      }
    }
    // Set the Power Attack / Deadly Aim stance for this turn FIRST (free toggle):
    // kept on for the damage, eased off against a target too well-armored to power
    // through. Done here so the swing that follows uses the right stance.
    this._botStance(m, foes);
    // AZWRAITH the TRIP-FIGHTER: his reach fauchard sweeps a standing foe off its feet —
    // prone, it LOSES its turn, and he lands a FREE attack. That's his whole game (reach +
    // trip + the free strike that models his Combat-Reflexes AoO). He topples the biggest
    // still-standing, trippable, reachable threat; already-prone foes he just hits (prone =
    // easy). If nothing's trippable, fall through to a normal swing (which cleaves from L4).
    if (m.playerId === 'azwraith') {
      const tripSlot = this._abilitiesFor(m).findIndex(ab => ab.effect === 'trip');
      if (tripSlot >= 0) {
        const prey = foes.filter(e => e.hp > 0 && !e.prone && !e.loseTurn && this._canReach(m, e) && !this._tripBlocked(e))
                         .sort((a, b) => b.hp - a.hp)[0];
        if (prey) { const r = this._useAbility(m, tripSlot, { targetUid: prey.uid }); if (r && r.ok) { this._hasteBonus(m); return; } }
      }
    }
    // LORD GWEYIR (Order of the Flame): every turn he GLORIOUS-CHALLENGES + strikes in one motion.
    // FLAME DOCTRINE (Tobias 2026-07-27): below 2 stacks he picks the WEAKEST reachable
    // foe — fast kills build the streak — then at 2+ stacks he TURNS on the biggest
    // target on the field, cashing the compounded morale damage where it matters.
    if ((m.playerId || '').toLowerCase() === 'lord gweyir') {
      const gcSlot = this._abilitiesFor(m).findIndex(ab => ab.effect === 'gloriouschallenge');
      if (gcSlot >= 0) {
        const live = foes.filter(e => e.hp > 0);
        const pool0 = live.filter(e => this._canReach(m, e));
        const pool = pool0.length ? pool0 : live;
        const weakest = pool.slice().sort((a, b) => a.hp - b.hp)[0];
        const biggest = pool.find(e => e.boss) || pool.slice().sort((a, b) => (b.maxHp || b.hp) - (a.maxHp || a.hp))[0];
        const prey = ((m.gloriousN || 0) >= 2) ? biggest : weakest;
        // v3.37.105 (Tobias's law): the bellow is a SWIFT MARK now — issue it only
        // when no live mark stands, then FALL THROUGH and fight (the kill of the
        // mark by his own blow banks the charge via _gcBank).
        const markAlive = m._gcTargetUid && live.some(e => e.uid === m._gcTargetUid);
        if (prey && !markAlive) this._useAbility(m, gcSlot, { targetUid: prey.uid });
      }
    }
    // SLAYER auto-STUDIES its prey (Studied Target is a swift/free action): mark the
    // foe it's about to fight so its attacks land the +N insight bonus. Re-mark when
    // the old mark is dead or gone.
    if ((m.cls === 'slayer' || m.cls === 'investigator') && (m.studiedId == null || !foes.some(e => e.uid === m.studiedId && e.hp > 0))) {   // v3.37.128 (Toby: 'follow pf1' — half rogue, half alchemist): investigator bots study too
      const prey = this._preferredFoe(m, foes);
      if (prey) { m.studiedId = prey.uid; m.studiedN = m.cls === 'investigator' ? Math.max(1, Math.floor((m.level || 1) / 2)) : 1 + Math.floor((m.level || 1) / 5); this._note(`🎯 ${m.nickname} studies ${prey.name} — marking it for the kill.`); }   // investigator STUDIED COMBAT: +½ level (PF1); slayer keeps its own track
    }
    // BOT TACTICIAN (v3.37.92): a cavalier opens the fight by drilling the party —
    // share the best teamwork feat once per room, while the room is young and
    // there's a party to drill. (v3.37.101, Tobias: Tactician is a MOVE action
    // now — the drill happens and the cavalier STILL fights this same turn, so
    // the bot falls through to its normal attack instead of returning.)
    if (m.cls === 'cavalier' && !this._twkShare && this.round <= 2 && this.livingParty().length >= 3
        && ((m.abilityUses && m.abilityUses.tactician) || 0) > 0 && teamworkGrants(m.cls, m.level).size) {
      const tSlot = this._abilitiesFor(m).findIndex(ab => ab.effect === 'tactician');
      if (tSlot >= 0) this._useAbility(m, tSlot, {});   // free-action plumbing keeps the turn — keep acting below
    }
    // CAVALIER auto-CHALLENGES its prey when it has a Challenge use left (room-cost, limited):
    // swear the +level-damage oath on the foe it's about to fight, re-swear when the old quarry
    // is dead and a use remains. (Order of the Flame's Gweyir uses his GLORIOUS CHALLENGE
    // ability instead — handled up in the flame-cavalier hook, which returns before this.)
    if (m.cls === 'cavalier' && (m.challengedId == null || !foes.some(e => e.uid === m.challengedId && e.hp > 0)) && ((m.abilityUses && m.abilityUses.challenge) || 0) > 0) {
      const prey = this._preferredFoe(m, foes);
      if (prey) { m.challengedId = prey.uid; m.challengeN = m.level || 1; m.abilityUses.challenge = Math.max(0, (m.abilityUses.challenge || 0) - 1); this._note(`⚔️ ${m.nickname} challenges ${prey.name} — sworn to cut it down (+${m.challengeN} damage against it).`); }
    }
    // SPELL SYNTHESIS (Celeb the Theurge — Kobold Press): a limited number of
    // times per room (1/2/3 at L5/11/17) he casts ONE arcane + ONE divine spell in
    // a SINGLE turn. He lines the pair up by asking his own brain twice, once per
    // school (m._synthSchool restricts usable() to that side); the pair lands at
    // −4 to enemy saves / +4 CL vs SR (see _spellDC / _srBlocks reading
    // m._synthActive). Two castings = two of his party buffs by nature of the
    // buff-first brain, or a buff + a debuff. Only fires when BOTH schools have a
    // worthwhile cast — otherwise he saves it for a normal single spell.
    if (m.playerId === 'celeb' && (m.synthUses || 0) > 0) {
      m._synthSchool = 'arcane'; const cA = this._botAbility(m); m._synthSchool = null;
      if (cA && !cA.guard) {
        m._synthSchool = 'divine'; const cDp = this._botAbility(m); m._synthSchool = null;
        if (cDp && !cDp.guard) {
          m.synthUses--; m._synthActive = true;
          this._note(`✨🌓 ${m.nickname} weaves the arcane and the divine as ONE — SPELL SYNTHESIS! (${m.synthUses} left this room)`, '/audio/spell_buff_invoke.mp3');
          this._echoToTable('/audio/spell_buff_invoke.mp3');
          this._useAbility(m, cA.slot, cA.payload);
          m._synthSchool = 'divine'; const cD = this._botAbility(m); m._synthSchool = null;   // recompute after the arcane cast changed the board
          if (cD && !cD.guard) this._useAbility(m, cD.slot, cD.payload);
          m._synthActive = false;
          this._hasteBonus(m); return;
        }
      }
    }
    // Then see if a class ability is the smart play this turn (heal, buff,
    // blast, spell). If so, use it; otherwise fall back to a basic attack.
    const choice = this._botAbility(m);
    // v3.37.107 TOTAL DEFENSE (the guard sentinel): a dying, slot-dry caster
    // gives ground instead of feeding its turn to chip damage — +4 AC until
    // they act again (_foeTargetAC reads m._totalDefense). Consumes the turn.
    if (choice && choice.guard) {
      m._totalDefense = true;
      this._note(`🛡️ ${m.nickname} gives ground and GUARDS — total defense, +4 AC until they act again. Nothing left in the tank worth standing still for.`);
      return;
    }
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
  },
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
    // FLAME DOCTRINE (Tobias 2026-07-27): a glorious cavalier carrying 2+ stacks
    // protects his TO-HIT — the morale damage is already huge, so Power Attack's
    // −hit trades badly. Ease it off and land the loaded blows.
    if (!ranged && (m.gloriousN || 0) >= 2) want = false;
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
  },
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
  },
  _preferredFoe(m, foes) {
    if (!foes || !foes.length) return null;
    // Taunted → compelled to go straight for the taunter (cleared at turn's end).
    const forced = this._forcedFoe(m);
    if (forced) return forced;
    // GLORIOUS MARK (v3.37.105, Tobias's law): a cavalier with a live glorious
    // challenge finishes THAT foe — the charge only banks on his own killing blow.
    if (m._gcTargetUid) {
      const gcT = foes.find(e => e.uid === m._gcTargetUid && e.hp > 0);
      if (gcT && this._canReach(m, gcT)) return gcT;
    }
    // Melee fighters can't reach flyers — prefer grounded foes (fall back to flyers
    // only if that's all that's left, so the wasted-swing message still fires).
    const _w = m.weapon || weaponOf(m.gear, m.weaponKey);
    if (_w && !_w.ranged && !_w.reachFly) { const grounded = foes.filter(e => !e.flying); if (grounded.length) foes = grounded; }
    // v3.37.109 (Josh, spicy-marmot: "I don't think anyone attacked the flying
    // spellcasting big boy until close to the end" — the Lich): a RANGED or
    // flyer-reaching hero is often the ONLY one who can bite an airborne foe,
    // so while any flyer stands, that's their job.
    else if (_w && (_w.ranged || _w.reachFly || (m.canHitFlyers && m.flying))) { const flyers = foes.filter(e => e.flying); if (flyers.length) foes = flyers; }
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
  },
  // The juiciest prey for an UNSEEN killer striking from invisibility: enemy
  // CASTERS die first (arcane wizards, hold-shamans, priests), then the BOSS,
  // then whoever is closest to death — lowest HP breaks every tie.
  _sneakPrey(foes) {
    const byHp = foes.slice().sort((a, b) => a.hp - b.hp);
    return byHp.find(e => e.arcane || e.caster || e.healer)
        || byHp.find(e => e.boss)
        || byHp[0];
  },
  // Bot ability AI: pick a class ability for this turn, or null to basic-attack.
  // Priority: heal the hurt → raise buffs (smite/rage/shield/inspire/bane) →
  // blast/control a group → fire a spell or maneuver at the best target. Only
  // ever returns an ability that's actually usable right now (level + uses/pool).
  // ── FUTILITY LEDGER (v3.37.84 — Josh, runs clever-ferret/golden-panda) ──
  // Per-hero, per-ROOM tally of CC/dispel attempts against specific foes, so a
  // bot stops re-rolling a bet that keeps failing (Femmik cast Slow at a boss
  // whose Will auto-saved FIVE times; dispels at DC 32 with +18 four in a row).
  // Mirrors the enemy-side _holdResists futility (v3.37.83). Lazily re-keyed by
  // depth — a new room wipes it with NO reset-list wiring (the .68 lesson).
  _ccLedger(m) {
    if (!m._ccT || m._ccT.depth !== this.depth) m._ccT = { depth: this.depth, tries: {} };
    return m._ccT.tries;
  },
  _botAbility(m) {
    // v3.37.95: guard on the EFFECTIVE ability list, not the raw class kit.
    // KITS.theurge carries an empty abilities[] (its spells come from theurgeKit
    // via _abilitiesFor), so the old `kitFor(cls).abilities.length` early-out
    // silently reduced bot Celeb to at-will cantrips for every fight since
    // v3.37.85 (Josh, nimble-wombat: "Caleb is insisting on using cantrips…
    // did we break Caleb somehow?" — yes, we did).
    const allAbs = this._abilitiesFor(m);   // class kit + injected DOMAIN powers + the theurge dual list
    if (!allAbs.length) return null;
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
      // Spell Synthesis pairs ONE arcane + ONE divine LEVELED spell (Tobias 2026-07-08: "must use 1
      // arcane and 1 divine, they cannot both be one type"). While a school is being lined up, the
      // pick MUST be a leveled spell whose side is that school (or a dual-list 'both' spell) — this
      // rejects cantrips / non-spell abilities that carry no side, so the pair can never be same-type.
      if (m._synthSchool && (!(ab.slvl >= 1) || (ab.side !== m._synthSchool && ab.side !== 'both'))) return false;
      if (!this._charAllows(ab, m)) return false;   // char-gated forms (Rissa vs generic druids)
      if (!this._loadoutAllows(ab, m)) return false;   // PHASE C: bot only casts prepared/known spells
      if (ab.effect === 'form' && m.form && m.form.key === (ab.form && ab.form.key)) return false;   // already in this form
      if (ab.cost === 'pool') return (m.spellPool || 0) > 0;
      if (ab.cost === 'slot') return ((m.slots && m.slots[ab.slvl]) || 0) > 0;   // spontaneous: a slot of that level
      if (ab.cost === 'room') return ((m.abilityUses && m.abilityUses[ab.key]) || 0) > 0;
      if (ab.cost === 'run')  return ((m.runAbilityUses && m.runAbilityUses[ab.key]) || 0) > 0;   // don't re-pick a spent run cast (e.g. auto-Inspire/Bless)
      return true;                                         // 'free'
    };
    // TELEPORT TACTICS (Tobias 2026-07-04): a flying foe + a grounded melee ally
    // who can't reach it → blink the ally in (Dimension Door / Teleport). The
    // recipient becomes untouchable until this caster's next turn, and their
    // next strike reaches ANY foe with a full attack.
    // ESCAPE HATCH (Toby 2026-08-24): Dimension Door / Teleport yanks a SEIZED ally
    // out of a grapple — higher priority than the flyer ferry (a pinned ally is
    // losing turns right now). Same one-ferry-per-ally-per-room ledger.
    const seizedAlly = this.livingParty().find(a => a.hp > 0 && a.grappled && !a.blinkedBy && !a._ddFerried);
    if (seizedAlly) {
      const tpIdx = allAbs.findIndex(ab => ab.effect === 'tpstrike' && usable(ab));
      if (tpIdx >= 0) { seizedAlly._ddFerried = true; return { slot: tpIdx, payload: { allyUid: seizedAlly.playerId } }; }
    }
    const flyFoe = targets.find(e => e.flying);
    if (flyFoe) {
      // v3.37.109 ONE FERRY PER ALLY PER ROOM (Josh, spicy-marmot d2: Farrah spent
      // rounds 1-4 Dimension-Dooring Concetta and Binch — every round, forever —
      // instead of casting Chain Lightning, because a delivered ally's blink flags
      // clear the moment they strike and the branch saw them as "stuck" again).
      // The blink already lands them a full attack against ANY foe — once each is
      // delivery enough; after that the caster goes back to being a caster.
      const stuck = this.livingParty().find(a => a.hp > 0 && !this._isRanged(a) && !this._canReach(a, flyFoe) && !(a._tpStrike > 0) && !a.blinkedBy && !a._ddFerried);
      if (stuck) {
        const tpIdx = allAbs.findIndex(ab => ab.effect === 'tpstrike' && usable(ab));
        if (tpIdx >= 0) { stuck._ddFerried = true; return { slot: tpIdx, payload: { allyUid: stuck.playerId } }; }
      }
    }
    const slot = (ab) => allAbs.indexOf(ab);
    const avail = allAbs.filter(usable);
    if (!avail.length) {
      // v3.37.107 SAVE YOURSELF, the DRY case (sneaky-dumpling d4: this very
      // early-out is where slot-dry Celeb's brain gave up every round while a
      // Movanic Deva beat him from 91 HP to SLAIN — the self-preservation
      // block at the bottom of this function sat unreachable behind it).
      // Nothing castable means heal/buff are off the table; the one tool left
      // is TOTAL DEFENSE: a dying pure caster whose cantrip is a long shot
      // (10+ vs the softest touch AC) gives ground instead of plinking.
      if (PURE_CASTERS.has(m.cls) && m.hp > 0 && m.hp < m.maxHp * 0.35 && targets.length) {
        const _soft0 = Math.min.apply(null, targets.map(t => { try { return this._enemyAC(t, { touch: true }); } catch (_) { return 99; } }));
        if (_soft0 - ((m.castingMod || 0) + Math.floor(lvl / 2)) >= 10) return { guard: true };
      }
      return null;
    }
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
    if (this.round === 1 && this.constructor.BLASTER_OPENERS.has((m.playerId || '').toLowerCase())   // Dungeon static — reach it via this.constructor (the mixin has no `Dungeon` in scope; was a ReferenceError that crashed every bot turn → party runs booted to the poker table)
        && !anyDowned && topCR <= lvl && Math.random() < 0.65) {
      const b = bestBlast();
      if (b) return b;
    }
    // 0d9) THE SPEED RACE (v3.37.140 — Josh, flying-noodle: 'when you have 12
    //      enemies on the battlefield and a quarter of them are spellcasters...
    //      HASTE needs to be one of the first things to go up'): against a BIG or
    //      caster-heavy field, party speed beats the summon opener, ward setup and
    //      dispel duels — one cast covers everyone, every round it's up. Dinvaya
    //      spent the medusa room grounding flyers while her Blessing of Fervor sat
    //      unspent; the elite medusas hasted THEIR side twice.
    {
      const _bigField = targets.length >= 4 || targets.filter(e => e.arcane || e.healer || e.caster || e.spellstrike).length >= 2;
      if (_bigField && Math.random() < 0.8) {   // v3.37.141 (Toby): haste-first 'should weigh heavily' with 'a little rng' — 4 rounds in 5 the speed race wins; the 5th, another opening (summon, dispel) gets its day. Re-rolls every round until speed is up
        const _h0 = avail.find(a => a.effect === 'haste');
        if (_h0 && !this.livingParty().some(p => p.hasted > 0)) return { slot: slot(_h0), payload: {} };
      }
    }
    // 0e) SUMMONER OPENER (generic — Draymus's UNDEAD, Jason's DEVILS): if this caster has
    //     a summon ability and NONE of its minions is currently up, call the biggest one
    //     NOW — extra bodies soak hits and swing every round, so they're worth the most
    //     when summoned EARLY. This used to sit at the very bottom of the tree, after
    //     heals/buffs/haste/force-push and the whole offense cascade, so a cleric like
    //     Jason literally never reached it (Josh: "he hardly ever did shit other than holy
    //     smite and force pike — he had Summon Devil 2"). Revives (0) and the severe-heal
    //     jump still outrank it; a no-op for anyone without summons. Re-fires when the
    //     minions drop, limited by the ability's own uses.
    {
      const summonAb = avail.filter(a => a.effect === 'summon').sort((a, b) => (b.slvl || 0) - (a.slvl || 0))[0];
      if (summonAb && targets.length && !this.enemies.some(e => e.summoned && e.summonedBy === m.playerId && e.hp > 0)) {
        return { slot: slot(summonAb), payload: {} };
      }
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
             (a.effect === 'buff' && a.sticky && a.target === 'self' && !a.powerattack && !a.deadlyaim && !a.fightdefensively
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
          const worthy0 = this._dispelWorthyFoe();   // FUTILITY: 2 failed dispels vs this foe this room → stop (v3.37.84)
          const worthy = (worthy0 && (this._ccLedger(m)['dispel:' + worthy0.uid] || 0) < 2) ? worthy0 : null;
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
      // v3.37.127 (Josh, clever-anvil: 'my clerick just channeld when everyone was
      // at almost 100% hp... been telling you bout this one for a while'): the old
      // fallthrough fired on ANY scratch — Binch channeled EVERY round of a room
      // for +15-24 into a near-full party. Now the patch-up needs a REAL dent:
      // somebody under 75%, or enough total damage that a channel isn't wasted.
      const _missing = allies.reduce((s, a) => s + (a.undead ? 0 : Math.max(0, (a.maxHp || 0) - a.hp)), 0);
      const _dented = allies.some(a => !a.undead && a.hp < a.maxHp * 0.75) || _missing >= (m.level || 1) * 6;
      if ((channelHeal || bigCure) && _dented) return { slot: slot(channelHeal || bigCure), payload: {} };
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
    // 1a-bis) SELF-PRESERVATION (v3.37.84 — Josh, runs clever-ferret + lucky-puffin:
    //     "Celeb never casts invis even when it would save his ass"; AI Draymus went
    //     down in the depth-4 scraper room with Greater Invisibility sitting in his
    //     book). A badly-hurt caster spends the turn NOT dying: one defensive
    //     self-cast per room — Greater Invisibility (50% concealment), Displacement,
    //     Mirror Image, Stoneskin, or Fire Shield, whichever their kit actually has.
    //     Reactive (answers the battlefield), so no round-decay appetite gate.
    if (m.hp < m.maxHp * 0.45 && !m.invisible && !m.greaterInvis && m._selfDefDepth !== this.depth) {
      const def = ['invisgreater', 'displacement', 'mirrorimage', 'stoneskin', 'fireshield']
        .map(k => avail.find(a => a.key === k)).find(Boolean);
      if (def) { m._selfDefDepth = this.depth; return { slot: slot(def), payload: def.target === 'ally' ? { allyUid: m.playerId } : {} }; }
    }
    // 1b) Dispel Magic — free a SPELL-debuffed ally, or strip a foe buff that's
    //     genuinely WORTH the turn (Tobias: bards over-dispelled — grounding
    //     spell-flight yes, peeling a Shield ward no; otherwise fall through to
    //     fight/buff/debuff/heal like a real bard).
    const cleanse = avail.find(a => a.effect === 'cleanse');
    if (cleanse) {
      const allyDebuffed = allies.some(a => (a.paralyzed > 0 && a.heldDC != null) || a.slowed > 0 || a.blinded > 0);   // SPELL effects only — dispel can't touch grapple/stun/sickness (PF1, Tobias 2026-07-03)
      // FUTILITY: two failed dispels against this foe this room (its effective CL
      // outclasses ours — Femmik at +18 vs DC 32) → stop feeding it turns.
      const worthy0 = this._dispelWorthyFoe();
      const worthy = (worthy0 && (this._ccLedger(m)['dispel:' + worthy0.uid] || 0) < 2) ? worthy0 : null;
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
        // v3.37.97 HOPELESS-CANTRIP ESCALATION (Josh, scrambled-lynx d10: Celeb
        // zapped Jolt at touch AC 32 for NINE rounds — needing an 18 — while
        // holding Slay Living, which later landed for 125). If the at-will ray
        // needs a 17+ vs the deadliest standing foe, a leveled SAVE spell (no
        // attack roll — it ignores AC and mirror images) beats hoping, SR risk
        // and all. Highest slot level first: the kill spell before the slap.
        const big2 = targets[0];
        const atwillHit = (m.castingMod || 0) + Math.floor(lvl / 2);
        if (big2 && this._enemyAC(big2, { touch: true }) - atwillHit >= 17) {
          const saver = avail.filter(a => (a.slvl >= 1) && (a.effect === 'savedie' || a.effect === 'save_debuff' || (a.effect === 'aoe' && a.save)))
                             .sort((x, y) => (y.slvl || 0) - (x.slvl || 0))[0];
          if (saver) return { slot: slot(saver), payload: saver.effect === 'aoe' ? { targetUid: big2.uid, targetUids: targets.slice(0, 6).map(e => e.uid) } : { targetUid: big2.uid } };
        }
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
      // FUTILITY (v3.37.84, run golden-panda: Femmik + Celeb threw FIVE Slows at a
      // boss whose Will save cleared the DC every time): a foe that's been targeted
      // twice this room and still isn't slowed is a proven bad bet — leave it out.
      const led = this._ccLedger(m);
      const fresh = targets.filter(t => !(t.slowed > 0) && !t.fascinated && (led['slow:' + t.uid] || 0) < 2);
      if (fresh.length >= 2) {
        const picks = fresh.slice(0, slowAb.maxTargets || 3);
        for (const t of picks) led['slow:' + t.uid] = (led['slow:' + t.uid] || 0) + 1;
        return { slot: slot(slowAb), payload: { targetUids: picks.map(e => e.uid) } };
      }
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
        // FUTILITY (v3.37.84): a boss that has shrugged the joke twice this room
        // isn't laughing — stop telling it (golden-panda: Laughter vs Will 32).
        const led = this._ccLedger(m);
        if (laugh && (led['save_debuff:' + boss.uid] || 0) < 2) {
          led['save_debuff:' + boss.uid] = (led['save_debuff:' + boss.uid] || 0) + 1;
          return { slot: slot(laugh), payload: { targetUid: boss.uid } };
        }
      }
    }
    // 2) Put up buffs once — Smite, then sticky self/party buffs (rage, shield,
    //    bane, divine favor, inspire). Sticky guard stops re-casting.
    const smite = avail.find(a => a.effect === 'smite' && !a.smiteGood && !m.smiteActive);
    if (smite) return { slot: slot(smite), payload: {} };
    // ANTIPALADIN mirror (v3.37.139): Smite Good only when a GOOD foe is actually
    // on the field (the celestial court) — an all-evil room would waste the use.
    const smiteG = avail.find(a => a.effect === 'smite' && a.smiteGood && !m.smiteGoodActive);
    if (smiteG && this.livingEnemies().some(e => e.good || e.markedGood)) return { slot: slot(smiteG), payload: {} };
    // Paladin: Detect Evil reveals NON-evil foes (animals/constructs) so Smite
    // bites them — a standard action, worth it when not every foe is already evil.
    const detectEvil = avail.find(a => a.effect === 'detectevil' && !a.detectGood);
    // …but only foes never yet SCANNED justify the standard action (v3.37.106):
    // one clean sweep answers the question for everyone it touched.
    if (detectEvil && this.livingEnemies().some(e => !e.evil && !e.markedEvil && !e._devScanned)) return { slot: slot(detectEvil), payload: {} };
    const detectGood = avail.find(a => a.detectGood);
    if (detectGood && this.livingEnemies().some(e => e.good && !e.markedGood && !e._dgScanned)) return { slot: slot(detectGood), payload: {} };
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
      if (!recips.length) return false;
      // SHIELD OF FAITH (deflection): a WASTED cast if the recipient already has an
      // equal-or-higher deflection bonus (a Ring of Protection, or another SoF) — it
      // won't stack, granting NO AC increase. A caster knows this and skips it.
      if (a.key === 'shieldoffaith') {
        const def = (a.buff && a.buff.deflect) || 0;
        return recips.every(w => !w || (w[flag] && w[flag][a.key]) || (Number(w.gear && w.gear.ring) || 0) >= def || ((w.buffs && w.buffs.deflect) || 0) >= def);
      }
      // STONESKIN ≡ STONESKIN (COMMUNAL) (v3.37.126, Josh, shielded-beaver: Kovira
      // pre-door-cast BOTH on herself — DR 10 doesn't stack, the slot was pure
      // waste): either key counts as "already stone-hard".
      const _eq = (a.key === 'stoneskin' || a.key === 'stoneskincomm') ? ['stoneskin', 'stoneskincomm'] : [a.key];
      return recips.every(w => w && _eq.some(k => (w.buffApplied && w.buffApplied[k]) || (w.runBuffApplied && w.runBuffApplied[k])));
    };
    // Protection from Fire — only worth a slot when fiery foes are on the field.
    const fireFoes = foes.some(e => e.detonate || e.hellfire || /fire|flame|magma|salamander|phoenix/i.test(e.name));
    const protect = avail.find(a => a.protectFire);
    if (protect && fireFoes && this.livingParty().some(p => !p.protectFire)) return { slot: slot(protect), payload: {} };
    // SHIELD vs ARCANE CASTERS — the one buff whose worth isn't its +4 AC. PF1: Shield
    // stops MAGIC MISSILE cold, and enemy sorcerers finish wounded heroes with unerring
    // missiles (the arcane branch in enemyAI). The potency floor below correctly writes
    // Shield off as a "petty" level-1 buff for a high-level caster in a NORMAL fight —
    // but against a room of arcane casters it's the difference between a wounded ally
    // living and dying. Verified in run tidy-dumpling (2026-07-20): six harpy sorcerers,
    // ZERO Shields cast all run, Tar Baphon (L14 wizard, Shield in his own book) killed
    // by two unerring volleys. REACTIVE, exactly like Protection from Fire above — it
    // answers the battlefield, so it is deliberately NOT gated by buffAppetite/potentEnough.
    const arcaneFoes = foes.some(e => e.arcane);
    const shieldSpell = avail.find(a => a.key === 'shield' && a.effect === 'buff');
    if (shieldSpell && arcaneFoes && !(m.buffApplied && m.buffApplied.shield)) return { slot: slot(shieldSpell), payload: {} };
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
      && !a.powerattack && !a.deadlyaim && !a.fightdefensively && !buffFullyUp(a)   // v3.37.126: FD is a STANCE managed by _botStance — the generic picker grabbing it made Danger flip it on every round (Josh: rapid-shotting at −6)
      && (a.target !== 'ally' || (m.level || 1) < 7 || (a.slvl || 0) >= 4));
    const fervor = avail.find(a => a.effect === 'haste');
    if (fervor && buffAppetite && !this.livingParty().some(p => p.hasted > 0)) buffCands.push(fervor);   // Haste/Fervor ranks by its own spell level
    buffCands.sort((x, y) => (y.slvl || 0) - (x.slvl || 0) || ((y.party ? 1 : 0) - (x.party ? 1 : 0)));
    if (buffCands.length) return { slot: slot(buffCands[0]), payload: {} };
    // Invisibility — shields the most-hurt ally (it lands on the lowest-HP ally in
    // _abInvisible). Cast when an ally is badly hurt and nobody's hidden yet.
    // …but NOT into an Invisibility Purge — it doesn't discriminate, so the cast would be
    // refused and the bot would burn its turn for nothing.
    const invis = this.invisPurged ? null : avail.find(a => a.effect === 'invisible');
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
    // 2b6b) FLY AN ALLY into the fight (Josh 2026-07-16): Fly is a touch spell, so a caster
    //       (Draymus, a wizard) should send a grounded MELEE ally aloft when flying foes are
    //       kiting the party out of reach — otherwise the angels just shoot from 30 ft and the
    //       whole line can't answer. Pick a martial ally who isn't already airborne and can't
    //       otherwise reach a flyer; the flown ally gains canHitFlyers, so they close in.
    const flyBuff = avail.find(a => a.effect === 'buff' && a.fly && a.target === 'ally');
    if (flyBuff && targets.some(e => e.flying)) {
      const grounder = allies.find(a => a.playerId !== m.playerId && a.hp > 0 && !a.left && !a.flying && !this._isRanged(a));
      if (grounder) return { slot: slot(flyBuff), payload: { targetUid: grounder.playerId } };
    }
    // 3) MILD wounds — control is down and the buffs are up; patch the party up
    //    BEFORE opening fire. (SEVERE wounds already jumped the queue at the top;
    //    nobody hurt → pickHeal returns null and the offense below proceeds.)
    { const h = pickHeal(); if (h) return h; }
    // 2b2) FORCE PUSH (Jason): if TWO+ melee allies can act, shoving a foe into the
    //      party to grant them ALL a free attack beats one cleric swing — Jason's a team
    //      enabler. Match _abForcePush's rule exactly (a melee fighter never sheathes
    //      mid-fight; the old "melee'd within the last round" gate made Jason skip the
    //      push when Freya/J'Mal plainly could strike — Josh 2026-07-15). Char-gated to Jason.
    { const fpush = avail.find(a => a.effect === 'forcepush');
      if (fpush && targets.length) {
        const ready = this.livingParty().filter(a => a.playerId !== m.playerId && a.hp > 0 && !a.left && !this._isRanged(a) && !(a.paralyzed > 0) && !(a.stunned > 0) && !a.asleep);
        if (ready.length >= 2) return { slot: slot(fpush), payload: { targetUid: (targets.find(e => e.boss) || targets[0]).uid } };
      } }
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
    // (The SUMMONER OPENER used to sit here — dead last, after heals/buffs/haste/force-push
    //  and the whole offense cascade, so a cleric like Jason NEVER reached it: something
    //  earlier always consumed the turn ("he hardly ever did shit other than holy smite and
    //  force pike... he had Summon Devil 2" — Josh 2026-07-15). Moved up to 0e, with the
    //  round-1 openers, where a summon actually earns its keep.)
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
        // FUTILITY (v3.37.84): don't offer a CC pick at a foe who has already
        // shrugged this effect twice this room (golden-panda: the charm/dominate
        // loop at the Pit Fiend — huge Will + SR, attempt after attempt).
        const _ccFx = a.effect === 'save_debuff' || a.effect === 'savedie' || a.effect === 'charm' || a.effect === 'dominate';
        // v3.37.99 MIND-CONTROL SANITY (Josh, plucky-gecko d5: Femmik charmed the
        // boss — Will +17 vs DC 20 — with almost nobody left to turn it on):
        // (1) never charm/dominate the LAST standing foe — its whole value is
        // attacking its allies; (2) don't even ATTEMPT mind control on a target
        // that saves on a 4 or better — that's not a gamble, it's a wasted turn.
        // (Hold/Laughter keep their try-twice ledger — those are worth gambles.)
        const _lastFoe = this.livingEnemies().filter(x => !x.summoned).length <= 1;
        const _mcDC = 10 + Math.floor((m.level || 1) / 2) + (m.castingMod || 4);
        const _mcHopeless = (t) => { try { return this._enemySave(t, 'will') + 4 >= _mcDC; } catch (_) { return false; } };
        // STANDING RULE (Tobias 2026-07-30, both AIs): don't retry a SAVE-OR-LOSE
        // on a target that has PROVEN a better-than-50% save. The first attempt is
        // always fair; after ONE observed save, retry only if the target still
        // fails on an 11 or better (the caster has seen the roll — engine save
        // bonus vs this caster's DC). The hard 2-attempt cap stays as the floor.
        const _svKind = a.save || 'will';
        const _svDC = 10 + Math.floor((m.level || 1) / 2) + (m.castingMod || 4);
        const _provenSaver = (t) => {
          const n = (this._ccLedger(m)[a.effect + ':' + t.uid] || 0);
          if (n >= 2) return true;
          if (!n) return false;
          try { return this._enemySave(t, _svKind) >= _svDC - 10; } catch (_) { return false; }
        };
        const el = targets.filter(t => this._spellWorksOn(a, t) && !((a.effect === 'charm' || a.effect === 'dominate') && (ccd(t) || t.dominated > 0 || _lastFoe || _mcHopeless(t))) && !(_ccFx && _provenSaver(t)));
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
      // Spiritual ALLY (v3.37.136) fights alongside the weapon — same doctrine, its own guard.
      if (!(m.spiritAlly && m.spiritAlly.rounds > 0)) {
        const sa = avail.find(a => a.effect === 'spiritally');
        if (sa) { const tough = targets.slice().sort((a, b) => b.maxHp - a.maxHp)[0] || weakestFoe; offense.push({ ab: sa, payload: { targetUid: tough.uid } }); }
      }
      const boltAction = !!weaponOf(m.gear, m.weaponKey).boltAction;   // can't Rapid Shot a bolt-action rifle
      for (const a of avail) if (['rapidshot', 'bullseye', 'cleave', 'trip', 'reckless', 'feint', 'disarm', 'stunfist', 'grapple', 'bullrush'].includes(a.effect)) {
        if (a.needsRepeating && boltAction) continue;
        // v3.37.120 (Josh, proud-kettle: 'he put on deadly aim and then bull rushed
        // a goddamn large ass robot... why wouldn't he just shoot them in the
        // fucking eyeball with his goddamn bow!'): a bot wielding a RANGED weapon
        // never picks a MELEE maneuver - trip/disarm/bull rush/grapple/cleave/
        // feint/reckless all want a blade in hand, not a bow. He shoots instead.
        if (this._isRanged(m) && ['trip', 'disarm', 'bullrush', 'grapple', 'cleave', 'feint', 'reckless', 'stunfist'].includes(a.effect)) continue;
        // v3.37.108 (Josh: bot Duristan averaged 35/round while he averaged 140
        // piloting the SAME character — silent-salmon vs proud-otter). The
        // single-shot ranged deeds predate the real full-attack engine: Bullseye
        // is ONE shot at +4, the Rapid Shot deed is TWO at −2 — but a shooter
        // with iteratives (BAB 6+) full-attacks 4-5 times on the BASIC attack,
        // Rapid Shot FEAT included (_attackOffsets). The bot was picking the
        // deed every round and throwing away the volley. Bots now skip both
        // deeds once iteratives exist; the buttons remain for humans and for
        // low-level shooters, where they still out-shoot a single basic attack.
        // v3.37.109: the .108 gate keyed on m.iteratives — which HIRED bots don't
        // carry (no derived ability scores), so Duristan kept single-shotting two
        // days after the "fix" (spicy-marmot). Level is the honest signal: every
        // class holding these deeds is full-BAB, so level 6+ ⇔ iteratives exist.
        if ((a.effect === 'rapidshot' || a.effect === 'bullseye') && ((m.iteratives || []).length > 1 || (m.level || 1) >= 6)) continue;
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
        // v3.37.110 (Josh, shielded-wombat d4: Lv-2 Duristan aimed at grounded
        // drones for two rounds while the Collector flew overhead): the ranged
        // deeds are legitimate at low level, but their aim was hard-coded to
        // weakest-first — bypassing _preferredFoe and its flyer preference.
        // The aimed shot now goes where the basic attack would: at the foe
        // nobody else can reach.
        if (a.effect === 'rapidshot' || a.effect === 'bullseye') {
          const prey = this._preferredFoe(m, targets) || weakestFoe;
          offense.push({ ab: a, payload: { targetUid: prey.uid } });
          continue;
        }
        offense.push({ ab: a, payload: { targetUid: weakestFoe.uid } });
      }
    }
    if (offense.length) {
      const choice = offense.find(o => o.ab.key !== m._lastAbilityKey) || offense[0];
      // FUTILITY tally (v3.37.84): count only the CC pick actually TAKEN — success
      // makes the foe ineligible next time anyway, so attempts ≈ failures.
      if (['save_debuff', 'savedie', 'charm', 'dominate'].includes(choice.ab.effect) && choice.payload && choice.payload.targetUid) {
        const led = this._ccLedger(m), k = choice.ab.effect + ':' + choice.payload.targetUid;
        led[k] = (led[k] || 0) + 1;
      }
      return { slot: slot(choice.ab), payload: choice.payload };
    }
    // v3.37.99 WHEN YOU CAN'T HURT IT, HELP SOMEONE (Josh, plucky-gecko d5: a
    // dry-of-save-spells Celeb Jolt-spammed the boss's touch AC 30, needing a
    // 20, round after round — "why weren't they helping?!"). If this is a caster
    // whose at-will is hopeless (17+ to hit) against EVERY standing foe and no
    // offensive pick fit above, spend the turn usefully instead: top up the
    // most-hurt ally (even chip damage counts when you're useless otherwise),
    // else raise a defensive buff that isn't already running. If the cantrip can
    // still hit SOMETHING, the basic attack remains the right call.
    const _isCasterM = !!(m.slots || m.spellPool || m.castingMod != null);
    const _atwillHit2 = (m.castingMod || 0) + Math.floor(lvl / 2);
    const _allHopeless = _isCasterM && targets.length && targets.every(t => { try { return this._enemyAC(t, { touch: true }) - _atwillHit2 >= 17; } catch (_) { return false; } });
    if (_allHopeless) {
      const hurt = allies.filter(a2 => !a2.undead && a2.hp < a2.maxHp * 0.8).sort((x, y) => (x.hp / x.maxHp) - (y.hp / y.maxHp))[0];
      const healAb = hurt && avail.find(a2 => a2.effect === 'heal');
      if (healAb) return { slot: slot(healAb), payload: { allyUid: hurt.playerId } };
      const defBuff = avail.find(a2 => a2.effect === 'buff' && a2.sticky && a2.target !== 'enemy' && !(m.buffApplied && m.buffApplied[a2.key]));
      if (defBuff) return { slot: slot(defBuff), payload: {} };
    }
    // v3.37.107 SELF-PRESERVATION — SAVE YOURSELF (Josh, sneaky-dumpling d4: a
    // slot-dry Celeb stood in a Movanic Deva's melee reach and plinked resisted
    // 5-point rays from 91 HP all the way down to SLAIN — 12 rounds — because
    // nothing in this brain ever read the bot's OWN life bar; the branch above
    // only fires when the cantrip can't hit ANYTHING). Below 35% HP a PURE
    // CASTER stops feeding its turn to chip damage: heal YOURSELF if any heal
    // is still castable, raise an unused sticky defensive buff, and — dry of
    // both, with only a long-shot cantrip left (10+ to touch) — give ground on
    // TOTAL DEFENSE (the {guard:true} sentinel; +4 AC until they next act).
    // (The fully-DRY twin of this check lives up at the `!avail.length`
    // early-out — a slot-dry caster never reaches this far.)
    if (PURE_CASTERS.has(m.cls) && m.hp > 0 && m.hp < m.maxHp * 0.35 && targets.length) {
      const healSelf = avail.find(a2 => a2.effect === 'heal');
      if (healSelf) return { slot: slot(healSelf), payload: { allyUid: m.playerId } };
      const defSelf = avail.find(a2 => a2.effect === 'buff' && a2.sticky && a2.target !== 'enemy' && !(m.buffApplied && m.buffApplied[a2.key]));
      if (defSelf) return { slot: slot(defSelf), payload: {} };
      const _soft = Math.min.apply(null, targets.map(t => { try { return this._enemyAC(t, { touch: true }); } catch (_) { return 99; } }));
      if (_soft - _atwillHit2 >= 10) return { guard: true };
    }
    return null;   // nothing fit → basic attack
  },
});
