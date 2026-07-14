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
        if (c) {
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
    // He picks the WEAKEST living foe — fast kills keep the streak rolling, so he pumps the stack on
    // fodder before it lands, monstrously, on a real threat. Each kill compounds his +damage/−AC.
    if ((m.playerId || '').toLowerCase() === 'lord gweyir') {
      const gcSlot = this._abilitiesFor(m).findIndex(ab => ab.effect === 'gloriouschallenge');
      if (gcSlot >= 0) {
        const prey = foes.filter(e => e.hp > 0 && this._canReach(m, e)).sort((a, b) => a.hp - b.hp)[0]   // weakest reachable first (build the streak)
                  || foes.filter(e => e.hp > 0).sort((a, b) => a.hp - b.hp)[0];
        if (prey) { const r = this._useAbility(m, gcSlot, { targetUid: prey.uid }); if (r && r.ok) { this._hasteBonus(m); return; } }
      }
    }
    // SLAYER auto-STUDIES its prey (Studied Target is a swift/free action): mark the
    // foe it's about to fight so its attacks land the +N insight bonus. Re-mark when
    // the old mark is dead or gone.
    if (m.cls === 'slayer' && (m.studiedId == null || !foes.some(e => e.uid === m.studiedId && e.hp > 0))) {
      const prey = this._preferredFoe(m, foes);
      if (prey) { m.studiedId = prey.uid; m.studiedN = 1 + Math.floor((m.level || 1) / 5); this._note(`🎯 ${m.nickname} studies ${prey.name} — marking it for the kill.`); }
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
      if (cA) {
        m._synthSchool = 'divine'; const cDp = this._botAbility(m); m._synthSchool = null;
        if (cDp) {
          m.synthUses--; m._synthActive = true;
          this._note(`✨🌓 ${m.nickname} weaves the arcane and the divine as ONE — SPELL SYNTHESIS! (${m.synthUses} left this room)`, '/audio/spell_buff_invoke.mp3');
          this._echoToTable('/audio/spell_buff_invoke.mp3');
          this._useAbility(m, cA.slot, cA.payload);
          m._synthSchool = 'divine'; const cD = this._botAbility(m); m._synthSchool = null;   // recompute after the arcane cast changed the board
          if (cD) this._useAbility(m, cD.slot, cD.payload);
          m._synthActive = false;
          this._hasteBonus(m); return;
        }
      }
    }
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
    const flyFoe = targets.find(e => e.flying);
    if (flyFoe) {
      const stuck = this.livingParty().find(a => a.hp > 0 && !this._isRanged(a) && !this._canReach(a, flyFoe) && !(a._tpStrike > 0) && !a.blinkedBy);
      if (stuck) {
        const tpIdx = this._abilitiesFor(m).findIndex(ab => ab.effect === 'tpstrike' && usable(ab));
        if (tpIdx >= 0) return { slot: tpIdx, payload: { allyUid: stuck.playerId } };
      }
    }
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
    if (this.round === 1 && this.constructor.BLASTER_OPENERS.has((m.playerId || '').toLowerCase())   // Dungeon static — reach it via this.constructor (the mixin has no `Dungeon` in scope; was a ReferenceError that crashed every bot turn → party runs booted to the poker table)
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
      if (!recips.length) return false;
      // SHIELD OF FAITH (deflection): a WASTED cast if the recipient already has an
      // equal-or-higher deflection bonus (a Ring of Protection, or another SoF) — it
      // won't stack, granting NO AC increase. A caster knows this and skips it.
      if (a.key === 'shieldoffaith') {
        const def = (a.buff && a.buff.deflect) || 0;
        return recips.every(w => !w || (w[flag] && w[flag][a.key]) || (Number(w.gear && w.gear.ring) || 0) >= def || ((w.buffs && w.buffs.deflect) || 0) >= def);
      }
      return recips.every(w => w && w[flag] && w[flag][a.key]);
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
    // 3) MILD wounds — control is down and the buffs are up; patch the party up
    //    BEFORE opening fire. (SEVERE wounds already jumped the queue at the top;
    //    nobody hurt → pickHeal returns null and the offense below proceeds.)
    { const h = pickHeal(); if (h) return h; }
    // 2b2) FORCE PUSH (Jason): if TWO+ melee allies have their weapons out (they
    //      melee'd within the last round), shoving a foe to grant them all a free
    //      attack beats one cleric swing. Char-gated to Jason (nobody else has it).
    { const fpush = avail.find(a => a.effect === 'forcepush');
      if (fpush && targets.length) {
        const ready = this.livingParty().filter(a => a.playerId !== m.playerId && a.hp > 0 && !a.left && !this._isRanged(a) && (this.round - (a._lastMeleeRound == null ? -99 : a._lastMeleeRound)) <= 1);
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
    // SUMMONER OPENER (generic — Draymus's UNDEAD, Jason's DEVILS): if this caster has a
    // summon ability and NONE of its minions is currently up, call the biggest one. Runs
    // for ANY class (the CLERIC summons too, not just the arcane casters below); char-gated,
    // so it's a no-op for anyone without summons. One standing summon at a time; heals/buffs
    // above still take priority (this is reached after them).
    {
      const summonAb = avail.filter(a => a.effect === 'summon').sort((a, b) => (b.slvl || 0) - (a.slvl || 0))[0];
      if (summonAb && targets.length && !this.enemies.some(e => e.summoned && e.summonedBy === m.playerId && e.hp > 0)) {
        return { slot: slot(summonAb), payload: {} };
      }
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
  },
});
