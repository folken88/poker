/**
 * game/dungeon/enemyAI.js — the VILLAIN BRAIN: everything enemies do on their
 * turn. Factory mixin on Dungeon.prototype: _monsterSwing/_enemyMelee (swing +
 * parry/evade resolution), _enemyAct (the turn decision tree), maneuvers
 * (_pickEnemyManeuver/_enemyGrapple/_enemyTrip/_enemyBullRush/_weightedPick/
 * _enemyMnvCMB/_enemyFightDefensively), caster brains (_lichCast dispatcher,
 * _enemyCastHold/_enemyShout/_enemyHoldHero/_enemyMissiles/_enemySpellstrike,
 * _enemyBlast/_enemyNuke + metamagic _enemyMeta/_metaDmg), support
 * (_enemyHeal/_enemyChannelNeg/_enemyTaunt/_enemyHook/_enemyConstrict/
 * _enemyHellfire) and the fire-skeleton _detonate.
 * Factory takes { SICKENED_PENALTY, HIGH_GROUND_HIT, ABILITY_MOD } (Dungeon
 * module tuning consts). PF1CORE: the pure math here (swing/DC/SR shapes)
 * migrates coreward in the consolidation sweep — targeting/choice stays here.
 * Depends on: game/combat (dice/pick/SND/weaponOf), pf1data monsters/classes.
 * 2026-07-04: born in the Phase-2 mixin split — bodies moved VERBATIM from
 * Dungeon.js (seam 3 of 4).
 */
const { weaponOf, SND, dRoll, dRollN, pick } = require('../combat');
const { crToNum } = require('../../pf1data/monsters');
const { babFor } = require('../../pf1data/classes');

// The metal chain-hook GRAB (the yank that reels a hero — or a flyer — in). Josh's
// pick: a Slorr "come here!" chain-rattle. Used for EVERY hook-grapple foe (the Slorr,
// the Gearsman Scraper, and any future chain grappler). Each foe's own hook.sound stays
// its CRUSH/constrict sound (the Scraper's live-current zap, the Slorr's grapple line);
// a foe can override just the grab with hook.grabSound.
const GRAB_CHAIN_SND = '/audio/slorr_come_here_grapple_chain.mp3';

module.exports = ({ SICKENED_PENALTY, SICKENED_ROUNDS, HIGH_GROUND_HIT, ABILITY_MOD, PARALYZE_DC }) => ({
  _monsterSwing(e, targetAC) {
    const sick = e.sickened > 0 ? SICKENED_PENALTY : 0;
    const pray = e.prayed || 0;   // Prayer: −1 to the enemy's attacks & damage
    // High ground: a flyer swooping on grounded heroes gets a to-hit edge.
    const toHit = e.toHit - sick - pray - (e.blinded > 0 ? 4 : 0) + (e.flying ? HIGH_GROUND_HIT : 0) - (e.fdOn ? 4 : 0);   // Fight Defensively: −4 to attacks
    const roll = dRoll(20), total = roll + toHit;
    if (roll === 1) return { hit: false, roll, toHit, total, ac: targetAC, sound: SND.fumble };
    const hit = roll === 20 || total >= targetAC;
    if (!hit) return { hit: false, roll, toHit, total, ac: targetAC, sound: pick(SND.whiffSword) };
    // GLORIOUS CHALLENGE (Order of the Flame): +2 melee damage per CONSECUTIVE glorious
    // challenge this room — a kill-streak morale bonus that compounds (see _enemyMelee).
    const glory = e.gloriousChallenge ? 2 * (e.gloriousN || 0) : 0;
    let dmg = e.dmgBonus - sick - pray + glory;
    for (let i = 0; i < (e.dmgCount || 1); i++) dmg += dRoll(e.dmgDie);   // e.g. golem slam = 2d10+9
    return { hit: true, damage: Math.max(1, dmg), roll, toHit, total, ac: targetAC, sound: pick(SND.flesh) };
  },
  _enemyAct(e) {
    e.flatFooted = false;   // acting ends flat-footed
    // PF1: standing up from prone is a MOVE ACTION. A slowed (staggered) creature's
    // single action is spent entirely on standing; everyone else stands and has
    // only their STANDARD left (one attack on the same target, or spend it closing
    // on a new one — see stoodUp in the melee economy below).
    let stoodUp = false;
    if (e.prone) {
      e.prone = false;
      if (e.slowed > 0) {
        this._note(`🐌 ${e.glyph} ${e.name}, slowed, struggles back to its feet — its single action spent standing.`, null, { side: 'enemy' });
        return;
      }
      stoodUp = true;
      this._note(`${e.glyph} ${e.name} clambers back to its feet (a move action).`);
    }
    if (!this.livingParty().length) return;
    // CHARMED (Charm Person): regards the party as friends and WON'T attack them.
    // It still tends its OWN side — a charmed healer mends a wounded ally — but
    // otherwise just waits it out. A hit from the party snaps the charm (see the
    // damage path). Overrides a taunt (a charmed foe won't be goaded into swinging).
    if (e.charmed) {
      e.taunted = null;
      if (e.healer && e.healsLeft > 0) {
        // A CONSTRUCT's repair works ONLY on machines — it can't mend organic allies
        // (living OR dead). See the canMend note in the main healer branch below.
        const wounded = this.livingEnemies().filter(x => x !== e && x.hp > 0 && x.hp <= x.maxHp * 0.5 && (e.type !== 'construct' || x.type === 'construct'))
          .sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0];
        if (wounded) return this._enemyHeal(e, wounded);
      }
      this._note(`💞 ${e.glyph} ${e.name}, charmed, won't raise a hand against you — it waits among its own.`, null, { side: 'enemy' });
      return;
    }
    // Taunted: compelled to go straight at the barbarian who taunted it — this
    // overrides its specials and target choice. The pull lasts only this (its
    // next) turn, so consume it now.
    let forced = null;
    if (e.taunted) {
      forced = this._targetableParty().find(p => p.playerId === e.taunted && p.hp > 0 && !p.left) || null;
      e.taunted = null;
      if (forced) this._note(`📢 ${e.glyph} ${e.name}, taunted, charges ${forced.nickname}!`, null, { side: 'enemy' });
    }
    if (!forced) {
      // Fire Skeleton: its whole purpose is to rush in and blow up. If it survives
      // to its turn, it detonates (and dies) instead of making a normal attack.
      if (e.detonate && !e._exploded) return this._detonate(e);
      // Enemy CLERICS tend their own: a priestly foe with healing left mends the
      // most-wounded living ally (itself included) once anyone drops below half —
      // but never wastes the prayer when the line is still healthy.
      if (e.healer && e.healsLeft > 0) {
        // SELECTIVE CHANNELING (Tobias 2026-07-03 — every channeler takes it): an
        // UNDEAD priest with 2+ wounded undead allies bursts negative energy over
        // ALL of them at once — and the feat keeps its LIVING allies out of the
        // burst entirely (no friendly sear either way). One wounded ally → the
        // old single-target prayer.
        if (e.type === 'undead') {
          const courtHurt = this.livingEnemies().filter(x => x.hp > 0 && x.type === 'undead' && x.hp <= x.maxHp * 0.5);
          if (courtHurt.length >= 2) return this._enemyChannelNeg(e, courtHurt);
        }
        // A CONSTRUCT's repair works ONLY on machines — its drills & welders can't mend
        // ORGANIC allies, living OR dead (a Gearghost can't "repair" a humanoid or an
        // undead). A living/undead priest-healer can still mend anyone on its own side.
        const canMend = (x) => e.type !== 'construct' || x.type === 'construct';
        const wounded = this.livingEnemies().filter(x => x.hp > 0 && x.hp <= x.maxHp * 0.5 && canMend(x))
          .sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0];
        if (wounded) return this._enemyHeal(e, wounded);
      }
      // WHISPERING WAY necromancers RAISE THE DEAD: summon undead reinforcements onto
      // their OWN side (the enemy mirror of Draymus's Summon Undead — real foes, not
      // allied summons). Front-loaded (rounds 1-2), then an occasional fresh wave, until
      // the rite is spent — so the party feels the horde swell. See _enemySummon.
      if (e.summon && e.summonLeft > 0 && (this.round <= 2 || dRoll(2) === 1)) return this._enemySummon(e);
      // Kobold shaman: cast Hold Person on an unheld target before resorting to melee.
      if (e.caster === 'holdperson' && e.castsLeft > 0) {
        // Smart caster: never Hold an UNDEAD hero — no mind to seize (same
        // knowledge the hero bots use; Tobias: "enemies play smart").
        const free = this._targetableParty().filter(m => !(m.paralyzed > 0) && !m.undead);
        if (free.length) return this._enemyCastHold(e, pick(free));
      }
      // Lich — a full WIZARD of its level. It casts every turn; its spellbook and
      // save DCs scale with the dungeon depth. _lichCast plays the controller:
      // lock a bruiser (Hold Monster), blast a cluster (Fireball/Cone/Chain),
      // delete the toughest (Disintegrate/Finger of Death), finish the wounded
      // (Magic Missile), or freeze one with its dread gaze.
      if (e.arcane && this._targetableParty().length) return this._lichCast(e);
      // Skeletal Champion: a bone-rattling shout — 1d8 + save-or-stunned.
      if (e.shout && e.shoutsLeft > 0 && dRoll(2) === 1) {
        // Undead heroes are immune to the stun (and to fear) — shout at the living.
        const awake = this._targetableParty().filter(m => !(m.stunned > 0) && !(m.paralyzed > 0) && !m.undead);
        if (awake.length) return this._enemyShout(e, pick(awake));
      }
      // Vampire (magus of its level): a Vampiric Touch spellstrike — a draining
      // melee blow that heals it. (Needs a grounded hero to touch.) A WOUNDED
      // vampire reaches for it every turn — the drain is its self-heal; a healthy
      // one mixes it in on a coin flip.
      if (e.spellstrike && (e.hp < e.maxHp * 0.7 || dRoll(2) === 1)) {
        // Vampiric Touch drains LIFE — an undead hero has none to drink (the
        // negative energy washes over them). Reach for the living.
        const reach = this._targetableParty().filter(m => !m.flying && !m.undead);
        if (reach.length) return this._enemySpellstrike(e, pick(reach.filter(m => m.paralyzed > 0).length ? reach.filter(m => m.paralyzed > 0) : reach));
      }
      // Goblin Barbarian: roar a taunt (once) to pull the party's AI onto it.
      if (e.taunt && e.tauntsLeft > 0 && this.livingParty().some(m => m.isBot)) return this._enemyTaunt(e);
      // Barbed Devil: occasionally a Hellfire Blast; otherwise chain-hook the
      // weakest hero and CRUSH whoever it's already grappling.
      // EAGER bombers (the alchemist Bomb Devil) throw on sight, every turn the
      // satchel holds out; others save the blast for a clustered party (1-in-3).
      if (e.hellfire && e.hellfireLeft > 0 && (e.hellfire.eager
        ? this._targetableParty().length >= 1
        : (this._targetableParty().length >= 2 && dRoll(3) === 1))) return this._enemyHellfire(e);
      if (e.hook) {
        const victim = this._targetableParty().find(p => p.grappled && p.grappledBy === e.uid);
        if (victim) return this._enemyConstrict(e, victim);
        // Smart hooker: skip Liberation inquisitors — their freedom of movement
        // slips every hold, so the chain would land damage but never grab.
        const hookable = this._targetableParty().filter(p => !this._freedomOfMovement(p));
        const weakest = (hookable.length ? hookable : this._targetableParty()).slice().sort((a, b) => a.hp - b.hp)[0];
        if (weakest) return this._enemyHook(e, weakest);
      }
    }
    // ── PF1 ACTION ECONOMY (melee) ── no grid here, so the spatial shortcut:
    // engaging a NEW target costs the MOVE action (closing the distance) plus the
    // STANDARD action (ONE attack). Staying on the SAME target next turn = a FULL
    // ATTACK — the whole multi-attack/natural routine. Mirrors the heroes' rule
    // in _attackOffsets. Specials above (casts/shouts/bombs/heals) are STANDARD
    // actions and already replace the attack; taunts/judgements stay free/swift.
    // FLYING heroes are out of reach of a GROUNDED foe; a flyer can hit them.
    // BUT a corporeal flyer that is HELD (paralyzed) or GRAPPLED has been dropped /
    // dragged down — a grounded foe can reach it again (Hold Person / Black Tentacles
    // ground even a Strix; incorporeal ghosts still drift out of reach).
    let noReach = false;
    const seen = this._targetableParty();
    const grounded = (m) => !m.flying || (!(m.incorporeal || m.ghost) && ((m.paralyzed > 0) || m.grappled));
    const living = e.flying ? seen : seen.filter(grounded);
    // SUMMONED undead fodder (Draymus) on the field — a foe can swing at them instead
    // of a hero. This is HALF the point of raising them: they SOAK. Reachable like any
    // other grounded body; mixed into the random target pool so summons draw the heat.
    const fodder = this.livingEnemies().filter(x => x.summoned && x.hp > 0);
    const reachFodder = e.flying ? fodder : fodder.filter(grounded);
    if (!living.length && !reachFodder.length) { noReach = (seen.length + fodder.length) > 0; }
    else {
      // ONE target for the whole turn: taunter > helpless > last turn's target > random
      // (random pool = reachable heroes + summoned fodder).
      let target = null;
      if (forced && forced.hp > 0 && !forced.left && (e.flying || !forced.flying)) target = forced;
      if (!target) {
        const helpless = living.filter(m => m.paralyzed > 0);
        const prev = living.find(m => m.playerId === e._lastAtkTarget) || reachFodder.find(s => s.uid === e._lastAtkTarget);
        target = helpless.length ? (helpless.find(m => m.playerId === e._lastAtkTarget) || pick(helpless)) : (prev || pick([...living, ...reachFodder]));
      }
      const tgtId = target.playerId || target.uid;
      // A SUMMON target: simple enemy-vs-summon blows (the fodder soaks) — no parry /
      // maneuver / close-the-distance, just swings. Reuses the enemy-vs-enemy path
      // (like a dominated foe attacking its kin): _monsterSwing vs the summon's AC,
      // _dmgE for the damage. Then the turn is done.
      if (target.summoned) {
        this._enemyFightDefensively(e);
        const swings = (e.slowed > 0) ? 1 : ((e._lastAtkTarget === tgtId) ? Math.max(1, e.attacks || 1) : 1);
        for (let i = 0; i < swings; i++) {
          if (target.hp <= 0) break;
          const r = this._monsterSwing(e, this._enemyAC(target));
          if (e.atkSounds && e.atkSounds.length) r.sound = pick(e.atkSounds); else if (r.hit && e.atkSound) r.sound = e.atkSound;
          if (r.hit) { this._dmgE(target, r.damage); this._note(`${e.glyph} ${e.name} smashes your undead ${target.name} for ${r.damage}!${target.hp <= 0 ? ' ☠️ Destroyed!' : ''}`, r.sound, { side: 'enemy' }); }
          else this._note(`${e.glyph} ${e.name} swings at your undead ${target.name} — and misses.`, r.sound, { side: 'enemy' });
        }
        e._lastAtkTarget = tgtId;
        this._echoToTable();
        return;
      }
      const fullAttack = e._lastAtkTarget === target.playerId && !stoodUp;   // stayed put → full routine (standing up ate the move)
      // PF1 SLOW = STAGGERED: a single move OR standard action each turn, never
      // both, never a full attack. Closing on a NEW target eats the whole turn
      // as movement (no swing); on the same target it strikes exactly once.
      if (e.slowed > 0 && !fullAttack) {
        this._note(`🐌 ${e.name}, slowed, lumbers toward ${target.nickname} — its single action spent just closing the distance.`, null, { side: 'enemy' });
        e._lastAtkTarget = target.playerId;
      } else if (stoodUp && e._lastAtkTarget !== target.playerId) {
        // Stood up (move) + closing on a NEW target (move) — no actions left to swing.
        this._note(`${e.glyph} ${e.name} rises and closes on ${target.nickname} — no time left to strike.`, null, { side: 'enemy' });
        e._lastAtkTarget = target.playerId;
      } else {
        // A badly-wounded foe may turtle up first (free action), then choose HOW to
        // attack via a weighted decision (see _pickEnemyManeuver) — so it doesn't
        // do the exact same thing every turn.
        this._enemyFightDefensively(e);
        if (target.grappled && target.grappledBy === e.uid) {
          this._enemyMelee(e, target);   // already holding them — crush instead of re-grabbing
        } else {
          const mode = (e.slowed > 0) ? 'attack' : this._pickEnemyManeuver(e, target);
          if (mode === 'grapple')       this._enemyGrapple(e, target);
          else if (mode === 'trip')     this._enemyTrip(e, target);
          else if (mode === 'bullrush') this._enemyBullRush(e, target);
          else {
            const swings = (e.slowed > 0) ? 1 : (fullAttack ? Math.max(1, e.attacks || 1) : 1);
            for (let i = 0; i < swings; i++) {
              if (target.hp <= 0 || target.left) break;   // target dropped mid-routine — the rest of the swings are spent closing on someone new
              this._enemyMelee(e, target);
            }
          }
        }
        e._lastAtkTarget = target.playerId;
      }
    }
    if (noReach) this._note(`${e.glyph} ${e.name} claws at the air — its prey is on the wing, out of reach!`, null, { side: 'enemy' });
  },
  // REACH ATTACK OF OPPORTUNITY (Tobias 2026-07-08): a foe that MOVES to engage — charging in or
  // switching to a new melee target — provokes a free strike from every reach-weapon hero
  // (polearm / fauchard / Kai's bastard's blade) who still has an AoO this round. Combat Reflexes
  // gives 1 + Dex-mod AoO per round (refreshed at the hero's turn in _advanceToActor; Cat's Grace
  // bumps it). A reach AoO can DROP the charger before its own blow lands.
  _provokeReachAoO(enemy) {
    if (!enemy || enemy.hp <= 0) return;
    for (const m of this.livingParty()) {
      if ((m._aooLeft || 0) <= 0) continue;
      const w = weaponOf(m.gear, m.weaponKey);
      if (!w || !w.reachFly || w.ranged) continue;   // reach MELEE weapon only
      m._aooLeft -= 1; m.weapon = w;
      const r = this._swingVsAC(m, this._enemyAC(enemy), enemy);
      if (r.hit) {
        this._dmgE(enemy, r.damage);
        this._note(`⚑ ${m.nickname}'s reach weapon catches ${enemy.name} on the move — ATTACK OF OPPORTUNITY for ${r.damage}${r.drTag || ''}!${this._afterEnemyHit(enemy)}`, r.sound);
        this._echoToTable(r.sound);
        if (enemy.hp <= 0) { this._tryBanter(m, 'down', { enemy: enemy.name }); return; }
      } else {
        this._note(`⚑ ${m.nickname}'s reach Attack of Opportunity at ${enemy.name} whiffs. ${this._atkStr(r)}`, r.sound);
        this._echoToTable(r.sound);
      }
    }
  },
  // One enemy swing at a chosen target (handles the paralysis rider + signature sound).
  _enemyMelee(e, target) {
    // A foe that MOVES to engage provokes: reach heroes get an AoO before it strikes (see above).
    if (target && e._lastMeleeTargetId !== target.playerId) { e._lastMeleeTargetId = target.playerId; this._provokeReachAoO(e); if (e.hp <= 0) return; }
    e.invisible = false;   // striking in melee breaks Invisibility (same rule as heroes)
    // _acOf strips shield AC for dual-wielders AND ranged-weapon wielders.
    const effAC = this._acOf(target).ac + this._acBonus(target) - (target.paralyzed > 0 ? 4 : 0) - (target.prone ? 4 : 0) - (target.stunned > 0 ? 2 : 0) - (target.slowed > 0 ? 1 : 0) - this._acPenalty(target);   // helpless / stunned / slowed / rage / reckless / cleave: easier to hit (enemy melee vs prone = −4)
    const r = this._monsterSwing(e, effAC);
    if (e.atkSounds && e.atkSounds.length) r.sound = pick(e.atkSounds);   // monk's randomized "bruce" kiai (hit or miss)
    else if (r.hit && e.atkSound) r.sound = e.atkSound;                    // rogue's "riki" stab (hit only)
    if (r.hit) {
      // Swashbuckler PARRY — the first melee attack against them each round can be
      // turned aside (parry roll vs the foe's attack total). On success: NO damage
      // and a free RIPOSTE. The attempt is spent for the round either way.
      if (target.cls === 'swashbuckler' && target._parryRound !== this.round && target.hp > 0 && !(target.paralyzed > 0) && !(target.stunned > 0)) {
        target._parryRound = this.round;
        const pRoll = dRoll(20) + babFor('swashbuckler', target.level || 1) + ABILITY_MOD + ((target.buffs && target.buffs.toHit) || 0) + this._hasteMod(target);
        if (pRoll >= r.total) {
          this._note(`🤺 ${target.nickname} PARRIES ${e.glyph} ${e.name}'s strike [${pRoll} vs ${r.total}] — no damage, and RIPOSTES!`, '/audio/sneak_riki.mp3');
          target.weapon = weaponOf(target.gear, target.weaponKey);
          const rr = this._swingVsAC(target, this._enemyAC(e), e);
          if (rr.hit) { this._dmgE(e, rr.damage); this._note(`🗡️ ${target.nickname}'s riposte hits ${e.name} for ${rr.damage}${rr.drTag || ''}.${this._afterEnemyHit(e)}`, rr.sound); if (e.hp <= 0) this._tryBanter(target, 'down', { enemy: e.name }); }
          else this._note(`🗡️ ${target.nickname}'s riposte misses ${e.name}. ${this._atkStr(rr)}`, rr.sound);
          this._echoToTable(rr.sound);
          return;   // the incoming attack is fully negated
        }
        this._note(`🤺 ${target.nickname} tries to parry, but ${e.name}'s blow beats the blade. [${pRoll} vs ${r.total}]`, null);
      }
      // Mirror Image / Displacement — a decoy soaks, or the blurred form is missed.
      if (this._evadeIncoming(target, e)) { this._echoToTable(r.sound); return; }
      e._engagedAlly = true;   // a melee foe that has struck an ally → within Point Blank Shot range this room
      let dmg = r.damage, sneakTag = '';
      // Enemy Sneak Attack (goblin/kobold rogues): +Xd6 vs a hero who's denied
      // their defenses — flat-footed (hasn't acted yet) or HELD by a shaman.
      if (e.sneakDice && (target.paralyzed > 0 || target.flatFooted)) {
        const sn = dRollN(e.sneakDice, 6); dmg += sn; sneakTag = ` 🗡️+${sn} sneak!`;
      }
      let drTag = ''; [dmg, drTag] = this._physDR(target, dmg);   // Stoneskin soaks physical blows
      target.hp -= dmg;
      this._note(`${e.glyph} ${e.name} hits ${target.nickname} for ${dmg}.${sneakTag}${drTag} ${this._atkStr(r)}`, r.sound);
      // DAUNTING SUCCESS (Order of the Flame — enemy parity, mirror of Lord Gweyir's L8 deed): a
      // CONFIRMED CRIT from the prince daunts the whole party — every (non-undead) hero is SICKENED
      // (−2 to hit, damage & saves) for a few rounds. Once per room; sickened ticks down, so it's a
      // temporary shaken, not a room-long lock. Undead heroes are fearless (immune).
      if (r.crit && e.gloriousChallenge && !e._dauntedRoom) {
        e._dauntedRoom = true;
        let n = 0;
        for (const m of this.livingParty()) { if (!m.undead) { m.sickened = Math.max(m.sickened || 0, SICKENED_ROUNDS); n++; } }
        if (n) this._note(`😱 ${e.glyph} ${e.name}'s GLORIOUS critical DAUNTS the party — ${n} hero${n > 1 ? 's' : ''} shaken (−2 to hit, damage & saves)! (Daunting Success)`, '/audio/draugr_shout03_burning.mp3', { side: 'enemy' });
      }
      // Domain parity (Death — Bleeding Touch): a death-priest foe's first landed
      // blow each room opens a BLEED on the hero (1d6 at their turn start, until
      // any magical healing staunches it). Undead heroes have no blood to spill.
      if (e.bleedTouch && !e._bleedUsed && target.hp > 0 && !target.undead && !target._bleeding) {
        e._bleedUsed = true; target._bleeding = true;
        this._note(`🩸 ${e.glyph} ${e.name}'s BLEEDING TOUCH opens a wound — ${target.nickname} bleeds 1d6 each round until magically healed!`, null, { side: 'enemy' });
      }
      this._fireShieldRetaliate(target, e);   // Fire Shield scorches a melee attacker
      // VICIOUS weapon (PF1): the blade bites its own wielder for 1d6 on every
      // hit (Burning Hate, the Black Sovereign's +5 vicious greatsword). The
      // recoil lands BEFORE the target-death returns so it's never skipped;
      // self-destruction follows the fire-skeleton precedent (hp → 0, note).
      if (e.vicious) {
        const recoil = dRoll(e.vicious);
        e.hp -= recoil;
        if (e.hp <= 0) { e.hp = 0; this._note(`🩸 The VICIOUS blade drinks ${recoil} from its wielder — ☠️ ${e.glyph} ${e.name} is consumed by his own weapon's hunger!`, null, { side: 'enemy' }); }
        else this._note(`🩸 The VICIOUS blade drinks ${recoil} from its own wielder (${e.hp}/${e.maxHp}).`, null, { side: 'enemy' });
      }
      // GLORIOUS CHALLENGE (Order of the Flame — the sahuagin prince): dropping a hero lets
      // the cavalier roar a fresh challenge over the body, stoking its frenzy. Each consecutive
      // kill this room stacks +2 melee damage AND −2 AC (it fights ever more recklessly — see
      // _monsterSwing / _enemyAC). Resets between rooms (the enemy is rebuilt fresh). Insane by
      // design: a prince left to carve through the party becomes a runaway threat.
      if (target.hp <= 0 && e.gloriousChallenge) {
        e.gloriousN = (e.gloriousN || 0) + 1;
        this._note(`🔥 ${e.glyph} ${e.name} bellows a GLORIOUS CHALLENGE over ${target.nickname} — its bloodlust swells! (Order of the Flame: +${2 * e.gloriousN} damage, −${2 * e.gloriousN} AC — cut it down FAST.)`, '/audio/draugr_shout03_burning.mp3', { side: 'enemy' });
      }
      if (target.hp <= -10) { this._memberDown(target); this._echoToTable(r.sound); return; }   // dead at −10
      if (target.hp <= 0)   { this._downMember(target); this._echoToTable(r.sound); return; }    // 0..−9 = down/dying
      if (e.paralyze && target.elemBody) { this._note(`🌪️ ${target.nickname}'s Elemental Body shrugs off the paralysis.`); }
      else if (e.paralyze) {
        const pdc = e.paralyzeDC || PARALYZE_DC;
        const sm = this._partySaveMod(target), sroll = dRoll(20), stot = sroll + sm;
        const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= pdc;
        if (!saved) { target.paralyzed = 1; target.paralyzedCL = this._enemyCL(e); this._note(`🥶 ${target.nickname} fails the paralysis save [d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs DC ${pdc}] — paralyzed!`); }
        else this._note(`${target.nickname} resists paralysis [d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs DC ${pdc}].`);
      }
      if (target.hp > 0 && target.isBot) this._tryBanter(target, 'damage', { enemy: e.name, dmg: r.damage });
    } else {
      this._note(`${e.glyph} ${e.name} misses ${target.nickname}. ${this._atkStr(r)}`, r.sound);
    }
    this._echoToTable(r.sound);
  },
  // ── ENEMY COMBAT MANEUVERS ──────────────────────────────────────────────────
  // Foes don't just swing every turn. After their special abilities, a plain melee
  // foe rolls a WEIGHTED decision (partly fixed weights, partly RNG) over the attack
  // modes it can use on its target — so the same monster mixes things up turn to turn.
  // A foe's maneuver bonus: its attack bonus stands in for BAB+STR.
  _enemyMnvCMB(e) { return dRoll(20) + (e.toHit || 0); },
  // Is this hero a soft, high-value backliner (a caster) — prime grapple bait?
  _isSquishy(m) { return /wizard|sorcerer|cleric|oracle|druid|bard|witch|magus|inquisitor|summoner|alchemist/.test((m.cls || '').toLowerCase()); },
  // Weighted random pick from [[key, weight], …].
  _weightedPick(menu) {
    const total = menu.reduce((s, [, w]) => s + w, 0);
    if (total <= 0) return menu[0][0];
    let r = dRoll(total);
    for (const [k, w] of menu) { r -= w; if (r <= 0) return k; }
    return menu[0][0];
  },
  // Build the menu of attack modes this foe could use on `target` and pick one.
  // Plain ATTACK dominates; maneuvers are the spice. Capability gates: incorporeal
  // foes can't grab/topple; you can't grapple the already-grappled or topple the
  // already-prone. Casters draw a heavier grapple weight (drag off the squishy!).
  _pickEnemyManeuver(e, target) {
    if (e.ranged) return 'attack';                      // an archer doesn't wrestle
    const corporeal = !e.incorporeal;
    const menu = [['attack', 12]];
    if (corporeal && !target.grappled) menu.push(['grapple', this._isSquishy(target) ? 6 : 3]);
    if (corporeal && !target.prone)    { menu.push(['trip', 2]); menu.push(['bullrush', 2]); }
    return this._weightedPick(menu);
  },
  // A free defensive-stance toggle (doesn't cost the action): a badly-wounded foe
  // turtles up (+2 AC, −4 to hit) to survive; it drops the guard once recovered.
  _enemyFightDefensively(e) {
    const hurt = e.hp > 0 && e.hp <= e.maxHp * 0.35;
    if (hurt && !e.fdOn) { e.fdOn = true; this._note(`🛡️ ${e.glyph} ${e.name}, badly wounded, takes a DEFENSIVE stance (+2 AC, −4 to hit).`, null, { side: 'enemy' }); }
    else if (!hurt && e.fdOn) { e.fdOn = false; this._note(`${e.glyph} ${e.name} drops its guard and presses the attack.`, null, { side: 'enemy' }); }
  },
  // GRAPPLE a hero — CMB vs the hero's CMD. Success: seized (−2 to hit, easier to
  // hit), crushed for a free strike, grip lasts ~2 rounds (the hero struggles free
  // on their turn — see _advanceToActor). Dispel/Grease break it early.
  // LIBERATION domain (Phase B — was the hardcoded inquisitor grant): freedom of
  // movement is now a POOLED, auto-firing domain power — CASTER LEVEL rounds per
  // room (PF1 "level rounds/day"; the room is the day). Each prevented impediment
  // spends one round via _fomSpend; at 0 the grapple/hold lands normally.
  // Inquisitors DEFAULT to Liberation (db.getDomains), so Tim's "never grapple me
  // again" behavior persists — now with the real PF1 limit.
  _freedomOfMovement(m) { return !!m && (m._domFoMRounds || 0) > 0; },
  _fomSpend(m, what) {
    if (!this._freedomOfMovement(m)) return false;
    m._domFoMRounds -= 1;
    this._note(`🕊️ LIBERATION — ${m.nickname} shrugs off ${what} (${m._domFoMRounds} round${m._domFoMRounds === 1 ? '' : 's'} of freedom left).`);
    return true;
  },
  _enemyGrapple(e, target) {
    if (this._fomSpend(target, `${e.name}'s grab`)) {
      this._echoToTable(); return;
    }
    const cmb = this._enemyMnvCMB(e), cmd = this._heroCMD(target);
    if (cmb < cmd) { this._note(`🤼 ${e.glyph} ${e.name} lunges to grab ${target.nickname}, who twists away. [CMB ${cmb} vs CMD ${cmd}]`, pick(SND.whiffSword), { side: 'enemy' }); this._echoToTable(); return; }
    target.grappled = true; target.grappledBy = e.uid; target.grappleRounds = 2; target.grappledCL = this._enemyCL(e); target.grappleCMB = e.toHit || 0;   // stamp CMB for the cast-while-grappled concentration DC
    this._note(`🤼 ${e.glyph} ${e.name} GRAPPLES ${target.nickname} — seized! −2 to hit and easier to strike until they break free. [CMB ${cmb} vs CMD ${cmd}]`, null, { side: 'enemy' });
    this._broadcast();
    this._enemyMelee(e, target);   // the crushing squeeze comes with the grab
  },
  // TRIP a hero — CMB vs CMD. Success: knocked prone (easier to hit until they
  // stand on their turn). A pure setup — no follow-up strike.
  _enemyTrip(e, target) {
    const cmb = this._enemyMnvCMB(e), cmd = this._heroCMD(target);
    if (cmb < cmd) { this._note(`🦵 ${e.glyph} ${e.name} sweeps at ${target.nickname}'s legs, but they keep their footing. [CMB ${cmb} vs CMD ${cmd}]`, pick(SND.whiffSword), { side: 'enemy' }); this._echoToTable(); return; }
    target.prone = true;
    this._note(`🦵 ${e.glyph} ${e.name} TRIPS ${target.nickname} — knocked PRONE, easier to hit until they stand! [CMB ${cmb} vs CMD ${cmd}]`, null, { side: 'enemy' });
    this._echoToTable(); this._broadcast();
  },
  // BULL RUSH a hero — CMB vs CMD. Success: bowled off their feet (prone) and the
  // charge carries through into a strike. Aggressive cousin of the trip.
  _enemyBullRush(e, target) {
    const cmb = this._enemyMnvCMB(e), cmd = this._heroCMD(target);
    if (cmb < cmd) { this._note(`💪 ${e.glyph} ${e.name} barrels into ${target.nickname}, who stands firm. [CMB ${cmb} vs CMD ${cmd}]`, pick(SND.whiffSword), { side: 'enemy' }); this._echoToTable(); return; }
    target.prone = true;
    this._note(`💪 ${e.glyph} ${e.name} BULL RUSHES ${target.nickname} off their feet and barrels in after! [CMB ${cmb} vs CMD ${cmd}]`, null, { side: 'enemy' });
    this._broadcast();
    this._enemyMelee(e, target);   // the charge carries through into a strike
  },
  // Kobold shaman's Hold Person: fail a Will save (DC 10 + ½ caster level) → lose a turn.
  _enemyCastHold(e, target) {
    e.castsLeft -= 1;
    // PF1: Hold is a mind-affecting compulsion — UNDEAD heroes (Tar-Baphon, Vrood,
    // Vesorianna, Farrus) have no mind to seize. (Mirrors the heroes' rule.)
    if (target.undead) { this._note(`🪄 ${e.glyph} ${e.name} casts Hold Person on ${target.nickname} — but the undead have no mind to seize. No effect.`, null, { side: 'enemy' }); this._broadcast(); return; }
    const dc = e.spellDC || 13;
    const sm = this._partySaveMod(target, ['enchantment', 'spell']), sroll = dRoll(20), stot = sroll + sm;   // Hold (compulsion spell)
    const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= dc;
    const roll = `[Will d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs DC ${dc}]`;
    if (!saved) {
      // HELD: multiple rounds, but the hero re-saves each of their turns (and the
      // attempt costs the turn either way) — see heldDC handling in _advanceToActor.
      target.paralyzed = Math.max(target.paralyzed || 0, 3); target.heldDC = dc; target.paralyzedCL = this._enemyCL(e);
      this._note(`🪄 ${e.glyph} ${e.name} casts Hold Person on ${target.nickname} — HELD! ${roll} (re-save each turn to break free)`, null, { side: 'enemy' });
    } else {
      this._note(`🪄 ${e.glyph} ${e.name} casts Hold Person on ${target.nickname}, who breaks free. ${roll}`, null, { side: 'enemy' });
    }
    this._broadcast();
  },
  // Skeletal Champion's shout: 1d8 sonic damage, Fort save or STUNNED 1 round.
  _enemyShout(e, target) {
    e.shoutsLeft -= 1;
    const cfg = e.shout || {};
    const fear = !!cfg.fear;   // Lich/Vampire sinister gaze: no damage, Will save or frozen in terror
    const dmg = fear ? 0 : dRollN(1, 8);
    if (dmg) this._dmgToMember(target, dmg);
    // PF1: undead are immune to FEAR and to STUNNING — a gaze does nothing to
    // them; the sonic shout still hurts but can't daze what doesn't breathe.
    if (target.undead) {
      this._note(fear
        ? `👁️ ${e.glyph} ${e.name} glares at ${target.nickname} — but the undead know no fear. No effect.`
        : `📢 ${e.glyph} ${e.name} shouts at ${target.nickname} for ${dmg} — the dead don't daze.`, cfg.sound || null);
      this._echoToTable(cfg.sound || null); this._broadcast(); return;
    }
    const dc = cfg.dc || e.spellDC || 14;
    const sm = this._partySaveMod(target, fear ? ['fear'] : []), sroll = dRoll(20), stot = sroll + sm;   // fear gaze → halfling/etc. fear bonus
    const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= dc;
    const roll = `[${fear ? 'Will' : 'Fort'} d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs DC ${dc}]`;
    const snd = cfg.sound || null;
    if (!saved && target.hp > 0 && target.elemBody) {
      this._note(`🌪️ ${target.nickname}'s Elemental Body shrugs off the ${fear ? 'terror' : 'stun'}. ${roll}`, snd);
    } else if (!saved && target.hp > 0) {
      target.stunned = Math.max(target.stunned || 0, 1); target.stunnedCL = this._enemyCL(e);
      this._note(fear
        ? `👁️ ${e.glyph} ${e.name}'s sinister gaze freezes ${target.nickname} in TERROR — loses a turn! ${roll}`
        : `📢 ${e.glyph} ${e.name} looses a bone-rattling shout — ${target.nickname} takes ${dmg} and is STUNNED! ${roll}`, snd);
    } else {
      this._note(fear
        ? `👁️ ${e.glyph} ${e.name} glares at ${target.nickname}, who steels their nerve. ${roll}`
        : `📢 ${e.glyph} ${e.name} shouts at ${target.nickname} for ${dmg}${target.hp > 0 ? ', who shrugs off the daze' : ''}. ${roll}`, snd);
    }
    this._echoToTable(snd);
    this._broadcast();
  },
  // Goblin Barbarian's Taunt: a Predator-roar challenge. EVERY hero (human or AI)
  // must make a Will save or be COMPELLED — its next attack (incl. a free Haste/
  // Cleave swing) is forced onto the goblin, no matter what it tried to target.
  // Once per encounter.
  _enemyTaunt(e) {
    e.tauntsLeft -= 1;
    const cfg = e.taunt || {};
    const dc = cfg.dc || 13;
    const snd = cfg.sound || null;
    let compelled = 0, total = 0;
    for (const m of this.livingParty()) {
      total++;
      const sm = this._partySaveMod(m), sroll = dRoll(20), stot = sroll + sm;
      const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= dc;
      if (!saved) { m.tauntedBy = e.uid; compelled++; }
    }
    // Grouped COUNTS (Josh 2026-07-05) — consistent with every other multi-target result, no per-hero roll-call.
    this._note(`📢 ${e.glyph} ${e.name} roars a furious challenge — ${compelled} compelled to strike it, ${total - compelled} shrug it off.`, snd, { side: 'enemy' });
    this._echoToTable(snd);
    this._broadcast();
  },
  // Barbed Devil's chain HOOK — hurled at the weakest hero; on a hit it bites for
  // damage and GRAPPLES them (cleared by Dispel Magic or Grease — see _abCleanse
  // / _abGrease). While grappled the hero takes −2 to hit and is easier to strike.
  _enemyHook(e, target) {
    const cfg = e.hook || {};
    const snd = cfg.grabSound || GRAB_CHAIN_SND;   // the chain-hook GRAB always rattles out the "come here!" chain (Josh); cfg.sound is reserved for the constrict/crush
    const effAC = this._acOf(target).ac + this._acBonus(target) - (target.paralyzed > 0 ? 4 : 0) - (target.prone ? 4 : 0) - this._acPenalty(target);
    const r = this._monsterSwing(e, effAC);
    if (!r.hit) {
      this._note(`⛓️ ${e.glyph} ${e.name} hurls its barbed chain at ${target.nickname} — the hook scrapes past. ${this._atkStr(r)}`, snd, { side: 'enemy' });
      this._echoToTable(snd); this._broadcast(); return;
    }
    const [hookDmg, hookDR] = this._physDR(target, r.damage);   // Stoneskin soaks the bite
    this._dmgToMember(target, hookDmg);
    const _fom = (!target.dead && target.hp > -10) ? this._fomSpend(target, 'the dragging hook') : false;
    const _yankedDown = !_fom && !target.dead && target.hp > -10 && target.flying;   // a thrown chain-hook can snag a FLYER and drag it out of the sky — that's how a GROUNDED mech grabs an airborne hero (Josh's "how did the non-flying scraper grapple my flying Olbryn?"). The grapple then keeps them grounded (see the `grounded` check in _enemyAct).
    if (!target.dead && target.hp > -10 && !_fom) { target.grappled = true; target.grappledBy = e.uid; target.grappledCL = this._enemyCL(e); target.grappleCMB = e.toHit || 0; }   // stamp CMB for the cast-while-grappled concentration DC
    this._note(`⛓️ ${e.glyph} ${e.name}'s hook BITES ${target.nickname} for ${hookDmg}${hookDR}${_fom ? ` — but Liberation's freedom of movement keeps them from being dragged into a grapple.` : `${_yankedDown ? ' — the chain SNATCHES them out of the air and drags them down' : ''} and drags them into a GRAPPLE! (Grease it or struggle free — no spell to dispel)`} ${this._atkStr(r)}`, snd, { side: 'enemy' });
    this._echoToTable(snd); this._broadcast();
  },
  // Crush a hero the devil is already grappling — automatic chain damage.
  _enemyConstrict(e, target) {
    const cfg = e.hook || {};
    const [dmg, drTag] = this._physDR(target, dRollN(2, 8) + 4);   // Stoneskin soaks the crush
    this._dmgToMember(target, dmg);
    this._note(`⛓️ ${e.glyph} ${e.name}'s chains CRUSH the grappled ${target.nickname} for ${dmg}${drTag}! (Grease it or struggle free — no spell to dispel)`, cfg.sound, { side: 'enemy' });
    this._echoToTable(cfg.sound); this._broadcast();
  },
  // Barbed Devil's Hellfire Blast — fire AoE on a random handful of heroes,
  // Reflex for half. Rolls its damage once for the whole burst.
  // An enemy priest channels restorative (or, for the undead court, profane)
  // energy into the most-wounded ally — cure dice scale with the priest's grade.
  // An undead priest's SELECTIVE Channel Negative — one burst mends every wounded
  // undead ally at once; Selective Channeling keeps living allies (and the burst's
  // harm side) out of it entirely. Costs one heal use, same dice as _enemyHeal.
  _enemyChannelNeg(e, courtHurt) {
    e.healsLeft = Math.max(0, (e.healsLeft || 0) - 1);
    const d = (e.healer && e.healer.dice) || 1;
    const heal = dRollN(d, 6) + ((crToNum(e.cr) || 0) >= 5 ? d : 0);   // burst d6s + Healer's Blessing at CR5+
    for (const a of courtHurt) a.hp = Math.min(a.maxHp, a.hp + heal);
    const living = this.livingEnemies().some(x => x.hp > 0 && x.type !== 'undead');
    this._note(`🌑 ${e.glyph} ${e.name} channels NEGATIVE energy over the court — black vitality knits ${courtHurt.length} undead for +${heal} HP each${living ? ' (Selective Channeling spares its living allies)' : ''}.`, '/audio/spell_umbral_bolt.mp3', { side: 'enemy' });
    this._echoToTable('/audio/spell_umbral_bolt.mp3'); this._broadcast();
  },
  _enemyHeal(e, ally) {
    e.healsLeft = Math.max(0, (e.healsLeft || 0) - 1);
    const d = (e.healer && e.healer.dice) || 1;
    // Domain parity (Healing — Healer's Blessing): a REAL priest (CR 5+) channels
    // deeper, +1 per die — the same aura the party's Healing-domain clerics get.
    const heal = dRollN(d, 8) + d * 3 + ((crToNum(e.cr) || 0) >= 5 ? d : 0);
    const before = ally.hp;
    ally.hp = Math.min(ally.maxHp, ally.hp + heal);
    const dark = e.evil || e.type === 'undead';
    const self = ally.uid === e.uid;
    const target = self ? 'its own wounds' : `${ally.name}'s wounds`;
    // CONSTRUCT support units don't pray — they REPAIR (Tobias 2026-07-04:
    // "instead of healing robots with black magic, they should repair, with
    // the drill sound"). Gearghost, Drone 3.0 Repairs, Fission Repair et al.
    if (e.type === 'construct') {
      const plating = self ? 'its own plating' : `${ally.name}'s plating`;
      this._note(`🔧 ${e.glyph} ${e.name} whirs alive — drills and welders REPAIR ${plating}: +${ally.hp - before} HP.`, '/audio/drill_lugnuts_airdrill.mp3', { side: 'enemy' });
      this._echoToTable('/audio/drill_lugnuts_airdrill.mp3'); this._broadcast();
      return;
    }
    this._note(`${dark ? '🖤' : '💚'} ${e.glyph} ${e.name} ${dark ? 'hisses a PROFANE PRAYER — black energy knits' : 'chants a HEALING PRAYER — light mends'} ${target}: +${ally.hp - before} HP.`, '/audio/spell_cure.mp3', { side: 'enemy' });
    this._echoToTable('/audio/spell_cure.mp3'); this._broadcast();
  },
  // PF1 Protection from Energy (fire): the ward is an ABSORPTION POOL (12 per
  // caster level, max 120) — incoming fire damage (after saves/resistance) eats
  // the pool until it's spent; the remainder burns through. Mutates t.protectFire.
  _fireSoak(t, dmg) {
    if (!(t.protectFire > 0) || dmg <= 0) return { dmg, tag: '' };
    const soak = Math.min(t.protectFire, dmg);
    t.protectFire -= soak;
    return { dmg: dmg - soak, tag: ` 🔥🛡absorbs ${soak}${t.protectFire <= 0 ? ' — ward SPENT' : ''}` };
  },
  _enemyHellfire(e) {
    e.hellfireLeft -= 1;
    const cfg = e.hellfire || {};
    const live = this._targetableParty().slice();
    for (let i = live.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [live[i], live[j]] = [live[j], live[i]]; }
    const hit = live.slice(0, dRoll(cfg.count || 3));
    const dc = cfg.dc || 18, full = dRollN(cfg.dice || 5, cfg.die || 6) + (cfg.bonus || 0);   // bonus = the alchemist's Int rider
    let hitN = 0, savedN = 0, downedN = 0;
    for (const t of hit) {
      const sm = this._partySaveMod(t), sroll = dRoll(20), stot = sroll + sm;
      const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= dc;
      let dmg = saved ? Math.floor(full / 2) : full;
      if ((cfg.dtype || 'fire') === 'fire') ({ dmg } = this._fireSoak(t, dmg));   // fire ward absorbs FIRE only
      this._dmgToMember(t, dmg);
      if (saved) savedN++; else hitN++;
      if (t.hp <= 0) downedN++;
    }
    // cfg.verb lets a dragon BREATHE and a bomb devil LOB instead of "hellfire".
    // COUNTS-ONLY report (Josh): the save type + DC + the burst damage + a tally of
    // hit/saved/downed — NOT a per-target list. Keeps mid-combat narration fast; the
    // blind player checks exact party HP on their own turn with H.
    const tally = `${hitN} hit${savedN ? `, ${savedN} saved` : ''}${downedN ? `, ${downedN} down` : ''}`;
    this._note(`🔥 ${e.glyph} ${e.name} ${cfg.verb || 'unleashes a HELLFIRE BLAST'} — Ref DC ${dc} (${full} ${cfg.dtype || 'fire'}): ${tally}!`, cfg.sound, { side: 'enemy' });
    this._echoToTable(cfg.sound); this._broadcast();
  },
  // Lich's Fireball (it casts as a wizard of its level): a roaring blast on a
  // random handful of heroes — Reflex for half, rolled once. Area damage, so it
  // reaches flyers too; Evasion negates a made save; Fire Ward halves it.
  // ── Lich: a full wizard of its level ───────────────────────────────────────
  // Its caster level scales with depth; save DCs = 10 + spell level + Int mod.
  // Each turn it reads the board and picks the strongest play. Spells unlock with
  // level, just like a real wizard climbing through the spell tiers.
  _lichCast(e) {
    const heroes = this._targetableParty();
    if (!heroes.length) return;
    const cl = Math.min(30, Math.max(12, this.depth || 12) + (e.bossLevels || 0));   // caster level by depth (+ boss advancement: bigger dice AND DCs)
    const im = 4 + Math.floor(cl / 4);                          // Intelligence modifier
    const dc = (slvl) => 10 + slvl + im;                        // PF1 spell save DC
    const MART = new Set(['fighter', 'barbarian', 'paladin', 'antipaladin', 'ranger', 'rogue', 'monk', 'magus', 'cavalier', 'inquisitor', 'slayer', 'bloodrager']);
    const byHp = heroes.slice().sort((a, b) => b.hp - a.hp);
    const strongest = byHp[0], weakest = byHp[byHp.length - 1];

    // ~1-in-6: freeze a hero with the dread gaze (its limited fear attack).
    if (e.shout && e.shoutsLeft > 0 && dRoll(6) === 1) {
      // The dread gaze is FEAR — undead heroes don't feel it; glare at the living.
      const awake = heroes.filter(m => !(m.stunned > 0) && !(m.paralyzed > 0) && !m.undead);
      if (awake.length) return this._enemyShout(e, pick(awake));
    }
    // ── SELF-BUFF (arcane survival) ── a caster "does everything heroes can": it
    //    conjures Mirror Image to soak blows, rises on Fly out of a melee swarm, or
    //    winks out with Invisibility when wounded. Cast SPARINGLY (it still wants to
    //    sling spells); each is DISPELLABLE and counters to Dispel / True Seeing /
    //    blindsense. Invisibility breaks the moment it next attacks (see _monsterSwing
    //    + the offensive casts below clearing e.invisible).
    const hurt = e.hp < e.maxHp * 0.6;
    const meleeSwarm = heroes.filter(m => MART.has(m.cls) && !m.flying).length >= 2;
    if (cl >= 4 && !(e.images > 0) && (this.round <= 2 || hurt) && dRoll(3) === 1) {
      e.images = Math.min(8, dRoll(4) + Math.floor(cl / 3));
      this._note(`🪞 ${e.glyph} ${e.name} conjures ${e.images} mirror image${e.images > 1 ? 's' : ''} — decoys to soak your blows!`, '/audio/spell_buff_invoke.mp3', { side: 'enemy' });
      this._echoToTable('/audio/spell_buff_invoke.mp3'); this._broadcast(); return;
    }
    if (cl >= 5 && !e.flying && meleeSwarm && dRoll(4) === 1) {
      e.flying = true; e.flyCast = true;   // mid-combat Fly (flyCast → dispellable; crashes prone if stripped)
      this._note(`🪽 ${e.glyph} ${e.name} rises into the air on wings of magic — grounded foes can't reach it!`, '/audio/spell_buff_invoke.mp3', { side: 'enemy' });
      this._echoToTable('/audio/spell_buff_invoke.mp3'); this._broadcast(); return;
    }
    if (cl >= 3 && !e.invisible && hurt && dRoll(3) === 1) {
      e.invisible = true;
      this._note(`👻 ${e.glyph} ${e.name} winks out of sight — you'll need True Seeing or blindsense to strike it!`, '/audio/spell_buff_invoke.mp3', { side: 'enemy' });
      this._echoToTable('/audio/spell_buff_invoke.mp3'); this._broadcast(); return;
    }
    e.invisible = false;   // any other cast below is hostile → invisibility drops
    // 1) Lock down a dangerous, un-held melee bruiser with Hold Monster (5th) —
    //    only if nobody's already held (don't waste it).
    const bruiser = heroes.find(m => !(m.paralyzed > 0) && !m.undead && MART.has(m.cls) && m.hp > m.maxHp * 0.4);   // undead heroes have no mind to hold
    if (cl >= 9 && bruiser && !heroes.some(m => m.paralyzed > 0)) return this._enemyHoldHero(e, bruiser, dc(5), 'Hold Monster');
    // 2) Finish a badly-wounded hero with auto-hitting Magic Missile (1st).
    if (weakest.hp <= weakest.maxHp * 0.28) return this._enemyMissiles(e, weakest, Math.min(5, Math.floor((cl + 1) / 2)));
    // 3) A cluster of foes → a rotating elemental blast. With 3+ heroes up the
    //    blast is ALWAYS the right spend (max coverage); at 2 it's a strong lean.
    if (heroes.length >= 2 && (heroes.length >= 3 || dRoll(5) <= 3)) {
      const blasts = [{ verb: 'hurls a FIREBALL', icon: '🔥', dtype: 'fire', dice: Math.min(10, cl), slvl: 3, count: () => dRoll(3) + 1, sound: '/audio/spell_fireball.mp3' }];
      if (cl >= 9)  blasts.push({ verb: 'breathes a CONE OF COLD', icon: '❄️', dtype: 'cold', dice: Math.min(15, cl), slvl: 5, count: () => dRoll(3) + 1, sound: '/audio/spell_coneofcold.mp3' });
      if (cl >= 11) blasts.push({ verb: 'looses CHAIN LIGHTNING', icon: '⚡', dtype: 'electricity', dice: Math.min(20, cl), slvl: 6, count: () => dRoll(4), sound: '/audio/spell_lightning.mp3' });
      // Smart blaster: a party wrapped in fire wards (Protection from Fire) eats
      // fireballs for free — reach for cold/lightning instead when it can.
      const unwarded = heroes.some(m => !m.protectFire);
      const pool = blasts.filter(b => b.dtype !== 'fire' || unwarded);
      const b = pick(pool.length ? pool : blasts);
      return this._enemyBlast(e, this._enemyMeta(e, cl, { ...b, die: 6, dc: dc(b.slvl) }));
    }
    // 4) Delete the most VALUABLE hero with a big single-target nuke — a lich
    //    knows to kill the CASTER first (the party's healing and blasting engine);
    //    only when no caster stands does it settle for the toughest body.
    //    Finger of Death (7th, negative) at high level, else Disintegrate (6th).
    const CASTERISH = new Set(['cleric', 'oracle', 'wizard', 'sorcerer', 'druid', 'bard', 'witch']);
    const priority = heroes.find(m => CASTERISH.has(m.cls) && m.hp > m.maxHp * 0.3) || strongest;
    if (cl >= 13 && dRoll(2) === 1) {
      return this._enemyNuke(e, priority, this._enemyMeta(e, cl, { verb: 'speaks a FINGER OF DEATH at', icon: '💀', dtype: 'negative', dice: Math.min(25, cl), die: 8, dc: dc(7), saveLbl: 'Fort', partialDice: Math.floor(cl / 2), sound: '/audio/spell_umbral_bolt.mp3' }));
    }
    return this._enemyNuke(e, priority, this._enemyMeta(e, cl, { verb: 'fires a DISINTEGRATE ray at', icon: '☢️', dtype: 'force', dice: Math.min(40, cl * 2), die: 6, dc: dc(6), saveLbl: 'Fort', partialDice: 5, dust: true, sound: '/audio/spell_disintegrate.mp3' }));
  },
  // PF1 metamagic parity — enemy casters spend big slots the way heroes do. Once
  // per room each, a CL12+ caster may EMPOWER (×1.5 damage) and a CL16+ caster may
  // MAXIMIZE (all dice max) a blast or nuke. Spell DC is unchanged (PF1 metamagic
  // never raises the DC), and the roll happens in _enemyBlast/_enemyNuke via cfg.meta.
  _enemyMeta(e, cl, cfg) {
    if (cl >= 16 && !e._maxUsed && dRoll(3) === 1) { e._maxUsed = true; cfg.meta = 'MAXIMIZED'; }
    else if (cl >= 12 && !e._empUsed && dRoll(3) <= 2) { e._empUsed = true; cfg.meta = 'EMPOWERED'; }
    if (cfg.meta) cfg.verb = cfg.verb.replace(/\b(?=[A-Z]{3,})/, `${cfg.meta} `).replace(/\ba (EMPOWERED)/, 'an $1');
    return cfg;
  },
  // Apply cfg.meta to a rolled damage total (dice already capped — Empower
  // multiplies the ROLLED result, Maximize replaces it, both per PF1).
  _metaDmg(cfg, rolled, dice) { return cfg.meta === 'MAXIMIZED' ? (dice != null ? dice : cfg.dice) * (cfg.die || 6) : cfg.meta === 'EMPOWERED' ? Math.floor(rolled * 1.5) : rolled; },
  // A lich AoE blast on a random handful of heroes — save for half (Evasion = none
  // on a made save; Fire Ward halves fire). Damage rolled once for the whole burst.
  _enemyBlast(e, cfg) {
    const live = this._targetableParty().slice();
    for (let i = live.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [live[i], live[j]] = [live[j], live[i]]; }
    const hit = live.slice(0, Math.max(1, cfg.count ? cfg.count() : dRoll(3) + 1));
    const full = this._metaDmg(cfg, dRollN(cfg.dice, cfg.die || 6));   // Empower/Maximize (see _enemyMeta)
    let hitN = 0, savedN = 0, downedN = 0, srN = 0;
    for (const t of hit) {
      if (this._srBlocksHero(e, t, 'the blast')) { srN++; continue; }   // PF1 SR (drow heroes)
      const sm = this._partySaveMod(t, ['reflex']), sroll = dRoll(20), stot = sroll + sm;   // blast = Reflex save (Slow −1 applies)
      const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= cfg.dc;
      let dmg = (saved && t.evasion) ? 0 : saved ? Math.floor(full / 2) : full;   // Evasion: no damage on a made save
      if (cfg.dtype === 'fire') ({ dmg } = this._fireSoak(t, dmg));   // PF1 ward: absorption pool, not a halving
      this._dmgToMember(t, dmg);
      if (saved) savedN++; else hitN++;
      if (t.hp <= 0) downedN++;
    }
    // COUNTS-ONLY (Josh): DC + burst damage + hit/saved/downed tally, no per-target list.
    const tally = `${hitN} hit${savedN ? `, ${savedN} saved` : ''}${srN ? `, ${srN} spell-resisted` : ''}${downedN ? `, ${downedN} down` : ''}`;
    this._note(`${cfg.icon} ${e.glyph} ${e.name} ${cfg.verb} — Ref DC ${cfg.dc} (${full} ${cfg.dtype}): ${tally}!`, cfg.sound, { side: 'enemy' });
    this._echoToTable(cfg.sound); this._broadcast();
  },
  // A lich single-target nuke — optional save for partial (Disintegrate / Finger
  // of Death). A foe reduced past −10 by Disintegrate crumbles to dust.
  _enemyNuke(e, target, cfg) {
    // PF1 SR: a drow hero's spell resistance can turn the whole nuke aside.
    if (this._srBlocksHero(e, target, cfg.verb ? `the ${(cfg.verb.match(/[A-Z][A-Z ]+[A-Z]/) || ['spell'])[0]}` : 'the spell')) { this._echoToTable(); this._broadcast(); return; }
    const full = this._metaDmg(cfg, dRollN(cfg.dice, cfg.die || 6));   // Empower/Maximize (see _enemyMeta)
    let dmg = full, tag = '';
    const sm = this._partySaveMod(target), sroll = dRoll(20), stot = sroll + sm;
    const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= cfg.dc;
    if (saved) { dmg = (saved && target.evasion) ? 0 : this._metaDmg(cfg, dRollN(cfg.partialDice || 5, cfg.die || 6), cfg.partialDice || 5); tag = ` [${cfg.saveLbl || 'Fort'} ${stot} vs ${cfg.dc}: ${target.evasion ? 'evaded' : 'partial'}]`; }
    else tag = ` [${cfg.saveLbl || 'Fort'} ${stot} vs ${cfg.dc}: fail]`;
    this._dmgToMember(target, dmg);
    const dust = cfg.dust && target.hp <= -10;
    this._note(`${cfg.icon} ${e.glyph} ${e.name} ${cfg.verb} ${target.nickname} for ${dmg} ${cfg.dtype || ''}${tag}!${target.hp <= 0 ? (dust ? ` ☠️ ${target.nickname} crumbles to DUST!` : ' ☠️') : ''}`, cfg.sound, { side: 'enemy' });
    this._echoToTable(cfg.sound); this._broadcast();
  },
  // Lich Hold Monster — a hero fails a Will save or is HELD (re-saves each turn,
  // the attempt costing the turn). Same mechanic as the shaman's Hold Person.
  _enemyHoldHero(e, target, dc, label) {
    // PF1: a mind-affecting compulsion — no effect on an undead hero.
    if (target.undead) { this._note(`🪄 ${e.glyph} ${e.name} casts ${label} on ${target.nickname} — but the undead have no mind to seize. No effect.`, null, { side: 'enemy' }); this._broadcast(); return; }
    if (this._srBlocksHero(e, target, label)) { this._broadcast(); return; }   // PF1 SR (drow heroes)
    const sm = this._partySaveMod(target, ['enchantment', 'spell']), sroll = dRoll(20), stot = sroll + sm;   // Hold (compulsion spell)
    const saved = sroll === 20 ? true : sroll === 1 ? false : stot >= dc;
    const roll = `[Will d20 ${sroll} ${this._fmtBonus(sm)} = ${stot} vs DC ${dc}]`;
    if (!saved) { target.paralyzed = Math.max(target.paralyzed || 0, 3); target.heldDC = dc; target.paralyzedCL = this._enemyCL(e); this._note(`🪄 ${e.glyph} ${e.name} casts ${label} on ${target.nickname} — HELD! ${roll} (re-save each turn to break free)`, '/audio/spell_dimensional_anchor.mp3', { side: 'enemy' }); }
    else this._note(`🪄 ${e.glyph} ${e.name} casts ${label} on ${target.nickname}, who resists. ${roll}`, null, { side: 'enemy' });
    this._broadcast();
  },
  // Lich Magic Missile — N unerring bolts (no save, no attack roll), 1d4+1 each.
  _enemyMissiles(e, target, n) {
    // PF1: SR applies even to Magic Missile's unerring bolts.
    if (this._srBlocksHero(e, target, 'the missiles')) { this._echoToTable(); this._broadcast(); return; }
    const dmg = dRollN(n, 4) + n;
    this._dmgToMember(target, dmg);
    this._note(`✨ ${e.glyph} ${e.name} looses ${n} Magic Missile${n > 1 ? 's' : ''} at ${target.nickname} — ${dmg} force, unerring.${target.hp <= 0 ? ' ☠️' : ''}`, '/audio/spell_magicmissile.mp3', { side: 'enemy' });
    this._echoToTable('/audio/spell_magicmissile.mp3'); this._broadcast();
  },
  // Vampire's Vampiric Touch spellstrike (it fights as a magus of its level): a
  // draining blow — weapon damage (DR applies) plus negative energy (it doesn't),
  // and the vampire HEALS the energy it drains.
  _enemySpellstrike(e, target) {
    const cfg = e.spellstrike || {};
    const SS = cfg.name || 'VAMPIRIC TOUCH';
    const effAC = this._acOf(target).ac + this._acBonus(target) - (target.paralyzed > 0 ? 4 : 0) - (target.prone ? 4 : 0) - this._acPenalty(target);
    const r = this._monsterSwing(e, effAC);
    const snd = cfg.sound || null;
    if (!r.hit) { this._note(`🩸 ${e.glyph} ${e.name}'s ${SS.toLowerCase()} misses ${target.nickname}. ${this._atkStr(r)}`, snd, { side: 'enemy' }); this._echoToTable(snd); this._broadcast(); return; }
    const [phys, drTag] = this._physDR(target, r.damage);   // Stoneskin soaks the weapon part only
    // PF1: negative energy doesn't harm the undead — vs an undead hero the touch
    // is just a weapon blow: no drain, no life to drink.
    if (target.undead) {
      this._dmgToMember(target, phys);
      // PF1: an INFLICT spell is negative energy — it HEALS the undead it strikes
      // (a WW Deathblade carving Adimarus mends him); Vampiric Touch just finds
      // no life to drink (weapon damage only).
      if (cfg.healsUndead) {
        const mend = dRollN(cfg.dice || 4, cfg.die || 8) + (cfg.bonus || 0);
        target.hp = Math.min(target.maxHp, target.hp + mend);
        this._note(`🩸 ${e.glyph} ${e.name}'s ${SS} strikes ${target.nickname} for ${phys}${drTag} — but the negative energy KNITS the undead for ${mend}! ${this._atkStr(r)}`, cfg.sound || null, { side: 'enemy' });
      } else {
        this._note(`🩸 ${e.glyph} ${e.name}'s ${SS} strikes ${target.nickname} for ${phys}${drTag} — but the negative energy washes over the undead harmlessly. ${this._atkStr(r)}`, cfg.sound || null, { side: 'enemy' });
      }
      this._echoToTable(cfg.sound || null); this._broadcast(); return;
    }
    const bonus = dRollN(cfg.dice || 4, cfg.die || 6) + (cfg.bonus || 0);       // negative energy ignores DR (flat bonus = +CL on inflicts)
    const total = phys + bonus;
    this._dmgToMember(target, total);
    let lifeTag = '';
    if (cfg.lifesteal && e.hp > 0) { const healed = Math.min(bonus, e.maxHp - e.hp); if (healed > 0) { e.hp += healed; lifeTag = ` and drinks ${healed} life (${e.hp}/${e.maxHp})`; } }
    this._note(`🩸 ${e.glyph} ${e.name}'s ${SS} rips ${target.nickname} for ${phys}${drTag}+${bonus} = ${total}${lifeTag}! ${this._atkStr(r)}`, snd, { side: 'enemy' });
    this._echoToTable(snd); this._broadcast();
  },
  // Fire Skeleton suicide bomber: on its turn it rushes in and DETONATES — one
  // fire roll (1d6 per party level) lands on 1d2 random heroes (no save, point-
  // blank), and the skeleton is consumed in the blast.
  _detonate(e) {
    const ex = e.detonate || {};
    const lvl = Math.max(1, this._minLevel());
    const d = dRollN(lvl, ex.die || 6);   // ONE roll: 1d6 per level, shared by everyone caught in it
    const live = this._targetableParty().slice();
    for (let i = live.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [live[i], live[j]] = [live[j], live[i]]; }
    const hit = live.slice(0, dRoll(ex.count || 2));   // 1d2 heroes caught in the blast
    const parts = [];
    for (const t of hit) { const s = this._fireSoak(t, d); this._dmgToMember(t, s.dmg); parts.push(`${t.nickname} −${s.dmg}${s.tag}`); }
    e._exploded = true; e.hp = 0;   // it consumes itself
    this._note(`💥 ${e.name} hurls itself among the heroes and DETONATES (${lvl}d6 fire = ${d})${parts.length ? ' — ' + parts.join(', ') : ' — but catches no one'}! It is destroyed.`, ex.sound, { side: 'enemy' });
    this._echoToTable(ex.sound);
  },
});
