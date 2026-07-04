/**
 * game/dungeon/serialize.js — the VIEW layer: everything the client sees.
 * Factory mixin on Dungeon.prototype: publicState (the whole dungeon:state
 * payload), _condList/_buffList/_enemyBuffList (status-icon strips),
 * _kitState (the action-UI ability list + uses), _heroACs (AC breakdown),
 * _xpInfo (XP progress). READ-ONLY — these build JSON, they never mutate.
 * Factory takes { fighterFeats } (shared helper living in game/Dungeon.js).
 * Depends on: persistence/db, game/combat (weaponOf/acOf/pick), pf1data
 * abilities/xp/races/domains.
 * 2026-07-03: born in the Phase-2 mixin split — bodies moved VERBATIM from
 * Dungeon.js (seam 2 of 4).
 */
const db = require('../../persistence/db');
const { weaponOf, acOf, pick } = require('../combat');
const { kitFor, roomUses, isPoolClass, isCaster, isSpontaneous, spellSlots, slotsFor, CANTRIP_BY_KEY } = require('../../pf1data/abilities');
const { xpProgress } = require('../../pf1data/xp');
const RACES = require('../../pf1data/races');
const { maxDomainsFor } = require('../../pf1data/domains');

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
  inspire:       { label: 'Inspire Courage', desc: 'allies +hit & damage — whole dungeon (scales with the bard: +1, +2 at 5, +3 at 11, +4 at 17)' },
  // ── Magus buffs (icons fall back to fitting existing art) ──
  displacement:  { label: 'Displacement',    desc: '50% of incoming attacks miss (this room)', icon: '/dungeon/buffs/fly.webp' },
  fireshield:    { label: 'Fire Shield',     desc: 'melee attackers scorched for 1d6+level fire (this room)', icon: '/dungeon/buffs/protevil.webp' },
  elementalbody: { label: 'Elemental Body',  desc: 'immune to crits, paralysis, stun, sicken & blind (this room)', icon: '/dungeon/buffs/stoneskin.webp' },
  trueseeing:    { label: 'True Seeing',     desc: 'see through darkness, illusions & invisibility (this room)', icon: '/dungeon/buffs/magearmor.webp' },
  mirrorimage:   { label: 'Mirror Image',    desc: 'shimmering decoys soak incoming attacks', icon: '/dungeon/buffs/fly.webp' },
};

module.exports = ({ fighterFeats, titleCase }) => ({
  // Active debuffs on a hero or monster, as PF1-system condition icons for the
  // dungeon UI. Members carry sickened/paralyzed; enemies add asleep/prone.
  // (Same flag names on both, so one helper serves heroes and monsters.)
  _condList(o) {
    const I = '/dungeon/conditions/', c = [];
    if (o.sickened > 0)  c.push({ key: 'sickened',  label: 'Sickened',  desc: '−2 to attacks & damage', icon: `${I}sickened.webp` });
    if (o.blinded > 0)   c.push({ key: 'blinded',   label: 'Blinded',   desc: '−4 to hit, denied Dex (easier to hit, Sneak-Attackable)', icon: `${I}sickened.webp` });
    if (o.paralyzed > 0) c.push(o.heldDC
      ? { key: 'held',      label: 'Held',      desc: 'helpless — re-saves each turn (the attempt costs the turn)', icon: `${I}paralyzed.webp` }
      : { key: 'paralyzed', label: 'Paralyzed', desc: 'frozen — loses turns; easy to hit', icon: `${I}paralyzed.webp` });
    if (o.slowed > 0)    c.push({ key: 'slowed',    label: 'Slowed',    desc: 'STAGGERED — one single action a turn: move OR attack, never both, never a full attack; −1 AC', icon: `${I}slowed.webp` });
    if (o.grappled)      c.push({ key: 'grappled',  label: 'Grappled',  desc: 'chained — −2 to hit, easier to strike; crushed each turn (Dispel or Grease frees you)', icon: `${I}grappled.webp` });
    if (o.prayed > 0)    c.push({ key: 'prayed',     label: 'Prayer',    desc: `−${o.prayed} to hit, damage & saves (cleric Prayer covers the battlefield)`, icon: `${I}shaken.webp` });
    if (o.stunned > 0)   c.push({ key: 'stunned',   label: 'Stunned',   desc: 'loses a turn', icon: `${I}stunned.webp` });
    if (o.asleep)        c.push({ key: 'asleep',     label: 'Asleep',     desc: 'helpless — loses turns until struck', icon: `${I}sleep.webp` });
    // Undead/ghost PARTY members — so everyone can see why the cures skip them.
    if (o.undead)        c.push({ key: 'undeadhero', label: 'Undead',     desc: 'positive energy does NOTHING (cures, channel, potions) — mend with Infernal Healing or Channel Negative', icon: `${I}markedevil.webp` });
    if (o.ghost)         c.push({ key: 'ghosthero',  label: 'Incorporeal', desc: 'a ghost — always flying, and half of all physical blows pass straight through her', icon: `${I}darkened.webp` });
    // Boss PRE-CAST wards — shown so the party knows what Dispel Magic can strip.
    if (o.precast && o.precast.length) {
      const PRE = {
        magearmor:     ['Mage Armor', '+4 armor AC (dispellable)'],
        shield:        ['Shield', '+4 AC and IMMUNE to Magic Missile (dispellable)'],
        shieldoffaith: ['Shield of Faith', '+3 deflection AC, even vs touch (dispellable)'],
        stoneskin:     ['Stoneskin', 'DR 10 vs physical blows (dispellable)'],
        protfire:      ['Fire Ward', `absorbs the next ${o.fireWard || 0} fire damage (dispellable)`],
        fly:           ['Fly (spell)', 'airborne by magic — DISPEL it and the boss crashes prone'],
      };
      // Ward chips reuse the PLAYER buff art — /dungeon/buffs/ already carries
      // every one of these by name (protfire's file is spelled protectfire).
      for (const k of o.precast) { const p = PRE[k]; if (p) c.push({ key: `pre_${k}`, label: p[0], desc: p[1], icon: `/dungeon/buffs/${k === 'protfire' ? 'protectfire' : k}.webp` }); }
    }
    else if (o.fascinated) c.push({ key: 'fascinated', label: 'Fascinated', desc: 'enthralled — loses turns; the first hit snaps it out', icon: `${I}fascinated.webp` });
    if (o.charmed)       c.push({ key: 'charmed',    label: 'Charmed',    desc: "won't attack your party — only tends its own side; a hit snaps it out", icon: `${I}fascinated.webp` });
    if (o.dominated > 0) c.push({ key: 'dominated',  label: 'Dominated',  desc: 'FIGHTS FOR THE PARTY — savages its own allies; a fresh Will save each of its turns can shake the hold', icon: `${I}fascinated.webp` });
    if (o.darkened > 0)  c.push({ key: 'darkened',  label: 'Darkness',  desc: 'shrouded in darkness — cannot act or be attacked (2 rounds)', icon: `${I}darkened.webp` });
    if (o.prone)         c.push({ key: 'prone',     label: 'Prone',     desc: 'knocked down — +4 for all to hit it', icon: `${I}prone.webp` });
    if (o.markedEvil)    c.push({ key: 'markedevil', label: 'Marked',   desc: 'revealed by Detect Evil — smite-able', icon: `${I}markedevil.webp` });
    return c;
  },

  // Active BUFFS on a hero, as Foundry-art icons for the dungeon UI. Sticky room
  // buffs (rage/bane/divine favor/prayer/shield) come from buffApplied; run-long
  // ones (bless/inspire) from runBuffApplied; smite/haste/invisible/judgement are
  // their own flags.
  _buffList(m) {
    const I = '/dungeon/buffs/', c = [], pushed = new Set();
    const push = (k, label, desc, icon) => { if (pushed.has(k)) return; pushed.add(k); c.push({ key: k, label, desc, icon: icon || `${I}${k}.webp` }); };
    // Every applied spell/feat buff carries its own icon via BUFF_META — walk the
    // recorded keys so any buff (new ones included) lights up automatically.
    // Only TRUTHY entries are active: a toggled-OFF Power Attack / Deadly Aim
    // leaves its key set to FALSE (not deleted), so checking key-existence alone
    // kept reporting it as "on" forever (Josh: L always said Power Attack on).
    for (const src of [m.buffApplied || {}, m.runBuffApplied || {}]) {
      for (const key of Object.keys(src)) {
        if (!src[key]) continue;
        const meta = BUFF_META[key];
        if (meta) push(key, meta.label, meta.desc, meta.icon);
      }
    }
    // Transient states tracked by their own flags, not in buffApplied:
    if (m.smiteActive)  push('smite', 'Smite', '+hit & +2×level damage vs evil');
    if (m.hasted > 0)   push('haste', 'Haste', `an extra attack each turn (${m.hasted} left)`);
    if (m.invisible)    push('invisible', 'Invisible', 'unseen — until you attack');
    if (m.flying)       push('fly', 'Flying', 'airborne — grounded foes cannot reach you');
    if (m.images > 0)   push('mirrorimage', 'Mirror Image', `${m.images} decoy${m.images > 1 ? 's' : ''} soaking incoming attacks`, '/dungeon/buffs/fly.webp');   // no mirrorimage.webp exists — reuse the shimmer icon (matches BUFF_META)
    if (m.untargetable) push('blur', 'Blurred', 'untargetable until your next turn (Bladed Dash)', '/dungeon/buffs/fly.webp');
    if (m.touchStrike > 0) push('dimblade', 'Dimensional Blade', 'your strikes hit on TOUCH this round', '/dungeon/buffs/magearmor.webp');
    if (m.protectFire > 0) push('protectfire', 'Fire Ward', `absorbs the next ${m.protectFire} fire damage (Protection from Fire)`);
    if (m.judgment === 'destruction') push('judg_destruction', 'Judgement: Destruction', '+damage on your strikes');
    if (m.judgment === 'protection')  push('judg_protection', 'Judgement: Protection', '+AC');
    if (m.judgment === 'healing')     push('judg_healing', 'Judgement: Healing', 'regenerate HP each turn');
    if (m.bane)                       push('bane', `Bane: ${titleCase(m.bane.type)}`, `+2 hit, +2d6+2 vs ${titleCase(m.bane.type)} (this room)`);
    if (m.mageArmor)                  push('magearmor', 'Mage Armor', '+4 armor AC (this dungeon)');
    if (m.blinkedBy || m._tpStrike > 0) push('blink', 'Blinked', 'stepped through folded space — untouchable until the caster next acts; next strike reaches ANY foe', '/dungeon/buffs/fly.webp');
    // Wild Shape — show the form's token as a buff badge (hawk has no token, but its
    // Flying badge already covers it above).
    if (m.form && m.form.art && !pushed.has('form_' + m.form.key)) { pushed.add('form_' + m.form.key); c.push({ key: 'form_' + m.form.key, label: m.form.label, desc: `Wild Shape: ${m.form.label}`, icon: m.form.art }); }
    return c;
  },

  // Active BOONS on an enemy (green-ringed buff icons), so players can see a foe
  // that's been hasted or pumped with combat buffs. Debuffs ride _condList.
  _enemyBuffList(e) {
    const I = '/dungeon/buffs/', c = [];
    if (e.hasted > 0) c.push({ key: 'haste', label: 'Hasted', desc: 'an extra attack each turn', icon: `${I}haste.webp` });
    if (e.buffs && ((e.buffs.toHit || 0) > 0 || (e.buffs.dmg || 0) > 0 || (e.buffs.ac || 0) > 0)) c.push({ key: 'buffed', label: 'Strengthened', desc: 'combat buffs active (+hit / +damage / +AC)', icon: `${I}bullsstrength.webp` });
    // Pre-cast wards (boss casters walk in pre-buffed) — these are DISPELLABLE, so
    // they MUST appear here or the blind Dispel picker won't offer the foe (Josh:
    // "cannot target a foe"). Mirrors the server's foeEnchanted check.
    if (e.precast && e.precast.length) c.push({ key: 'warded', label: 'Warded', desc: `pre-cast wards (${e.precast.join(', ')}) — dispellable`, icon: `${I}magearmor.webp` });
    // Mid-combat self-buffs (enemy casters) — all DISPELLABLE, so they show as
    // strip-able boons + the Dispel picker offers the foe.
    if (e.invisible)  c.push({ key: 'invisible',   label: 'Invisible',    desc: 'unseen — your hits suffer 50% concealment (True Seeing / blindsense pierce it); dispellable', icon: `${I}invisible.webp` });
    if (e.images > 0) c.push({ key: 'mirrorimage', label: 'Mirror Image', n: e.images, desc: `${e.images} decoy${e.images === 1 ? '' : 's'} soaking your blows — each hit has a 1-in-${e.images + 1} chance to tag the REAL foe; the rest pop a decoy. Dispellable.`, icon: `${I}fly.webp` });
    if (e.flyCast)    c.push({ key: 'flycast',     label: 'Flying',       desc: 'airborne by magic — grounded foes can\'t reach it; DISPEL it and it crashes', icon: `${I}fly.webp` });
    return c;
  },

  // ── Broadcasting ──────────────────────────────────────────────────────────
  publicState() {
    // Initiative lookup (keyed p:/e:) so the client can sort cards into initiative
    // order and animate the per-room re-order. Empty until _rollInitiative runs.
    const _initOf = {};
    for (const t of (this.turnOrder || [])) _initOf[t.kind[0] + ':' + t.id] = t.init;
    return {
      id: this.id,
      depth: this.depth,
      round: this.round,
      status: this.status,
      runGold: this.runGold,
      party: this.party.map(m => ({
        playerId: m.playerId, init: (_initOf['p:' + m.playerId] ?? null), nickname: m.nickname, avatarId: m.avatarId, isBot: m.isBot, crowned: !!m.crowned,
        cls: m.cls || 'fighter', weapon: m.weaponKey || 'dagger',
        race: m.race || 'human', raceName: RACES.raceName(m.race), vision: m.vision || 'normal', blindsense: m.blindsense || 0,   // PF1 race + vision (+ blindsense ft); blind mode reads vision; non-human shows on the hero card
        form: m.form ? { key: m.form.key, label: m.form.label, glyph: m.form.glyph, art: m.form.art } : null,   // active Wild Shape (drives the token swap on the hero card)
        level: m.level, ...this._xpInfo(m), ...this._heroACs(m), hp: Math.max(0, m.hp), maxHp: m.maxHp,
        abilityScores: m.abilityScores || null, abilityMods: m.mods || null, cantrip: this._cantripState(m),
        dead: !!m.dead, downed: !m.dead && !m.left && m.hp <= 0 && !this._hasFerocity(m),
        dyingHp: (!m.dead && !m.left && m.hp <= 0 && !this._hasFerocity(m)) ? m.hp : null,
        ferocious: !m.dead && !m.left && m.hp <= 0 && this._hasFerocity(m),   // orc fighting on at/below 0 HP
        left: !!m.left,
        sickened: m.sickened > 0, paralyzed: m.paralyzed > 0,
        // Auto-skip countdown — only for the human whose turn it currently is.
        afkAt: (this.status === 'combat' && !m.isBot && this._currentActorId() === m.playerId && m.afkDeadline) ? m.afkDeadline : null,
        queued: (!m.isBot && m.queuedAction) ? m.queuedAction.label : null,   // ⏳ pre-loaded action chip
        conditions: (!m.dead && !m.left && m.hp > 0) ? this._condList(m) : [],
        buffs: (!m.dead && !m.left && m.hp > 0) ? this._buffList(m) : [],
        smiteActive: !!m.smiteActive, buffed: !!(m.buffs && (m.buffs.toHit || m.buffs.dmg || m.buffs.bonusDice || m.buffs.ac)),
        kit: this._kitState(m),    // at-will + 2 abilities (+ remaining uses) for the action UI
      })),
      enemies: this.enemies.map(e => ({
        uid: e.uid, init: (_initOf['e:' + e.uid] ?? null), name: e.name, glyph: e.glyph, art: e.art || null, artPos: e.artPos || null, boss: !!e.boss, cr: e.cr || null,
        flying: !!e.flying,
        drDesc: e.dr ? this._drDesc(e.dr) : null,   // spoken in the blind E-inspector + shown on hover (why your hits run low)
        hp: Math.max(0, e.hp), maxHp: e.maxHp, alive: e.hp > 0, sickened: e.sickened > 0,
        align: e.align || 'NE', evil: !!e.evil, type: e.type || null,
        ac: e.ac, touchAC: (e.touchAC != null ? e.touchAC : Math.max(10, e.ac - 5)), ffAC: Math.max(10, e.ac - 2),
        flatFooted: !!e.flatFooted, prone: !!e.prone, fascinated: !!e.fascinated, asleep: !!e.asleep, charmed: !!e.charmed, darkened: (e.darkened > 0),
        dominated: (e.dominated > 0),   // Phase B: the client renders a dominated foe's card IN THE HERO ROW
        conditions: e.hp > 0 ? this._condList(e) : [],
        buffs: e.hp > 0 ? this._enemyBuffList(e) : [],
      })),
      turn: this._currentTurn(),
      // 🎯 aim telegraphy — only present, living humans' picks are shown.
      targeting: Object.fromEntries(Object.entries(this.targeting).filter(([pid]) =>
        this.party.some(p => p.playerId === pid && !p.left && !p.dead && !p.isBot))),
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
  },
  // XP progress fields for the client (current band into/span + XP to next level).
  _xpInfo(m) { const p = xpProgress(m.xp || 0); return { xp: p.xp, xpInto: p.into, xpSpan: p.span, xpToNext: p.toNext, maxLevel: p.next == null }; },
  _heroACs(m) {
    const a = this._acOf(m);
    const ac = a.ac + this._acBonus(m);
    // Itemized breakdown for the party-card tooltip — mirrors acOf + _acBonus
    // exactly (only GRANTED sources are listed; a suppressed shield shows why).
    const parts = ['10 base'];
    const w = m.weapon || weaponOf(m.gear, m.weaponKey);
    const armor = Number(m.gear?.armor) || 0, shield = Number(m.gear?.shield) || 0, ring = Number(m.gear?.ring) || 0;
    const arcaneNoArmor = (m.cls === 'wizard' || m.cls === 'sorcerer');
    if (arcaneNoArmor) { if (armor > 0) parts.push(`+${armor} armor enchant (no armor worn)`); }
    else { const base = (m.cls === 'barbarian' || m.cls === 'oracle') ? 6 : 9; parts.push(`+${base + armor} ${base === 6 ? 'breastplate' : 'full plate'}${armor ? ` +${armor}` : ''}`); }
    const noShield = !!(w && (w.noShield || w.ranged));
    if (shield >= 1 && m.cls !== 'swashbuckler' && m.cls !== 'magus' && !arcaneNoArmor && !noShield) parts.push(`+${2 + shield} shield +${shield}`);
    else if (shield >= 1) parts.push(m.cls === 'magus'
      ? '(shield owned but unused — the off hand is for spell combat; the Shield SPELL works)'
      : '(shield owned but unusable — hands full)');
    if (ring >= 1) parts.push(`+${ring} ring of protection`);
    if (m.mageArmor) parts.push('+4 Mage Armor');
    const buffAC = (m.buffs && m.buffs.ac) || 0;
    if (buffAC) parts.push(`+${buffAC} spell buffs`);
    if (m.judgment === 'protection') parts.push(`+${Math.max(1, Math.floor((m.level || 1) / 3))} Judgement: Protection`);
    const featAC = fighterFeats(m.cls, m.level, this._isRanged(m)).ac;
    if (featAC) parts.push(`+${featAC} feats (Dodge)`);
    if (this._hasteMod(m)) parts.push('+1 Haste (dodge)');
    if (m._fdAc) parts.push(`+${m._fdAc} Fighting Defensively (dodge)`);
    if (m._offDef) parts.push('+2 Offensive Defense');
    if (fighterFeats(m.cls, m.level, this._isRanged(m)).twDef && this._isDualWielding(m)) parts.push('+1 Two-Weapon Defense');
    return {
      ac,
      touchAC: Math.max(10, ac - a.physical - (m.mageArmor ? 4 : 0)),
      ffAC:    Math.max(10, ac - fighterFeats(m.cls, m.level, this._isRanged(m)).ac - (m._fdAc || 0)),   // a dodge bonus (Fight Defensively) is lost when flat-footed

      acBreak: `AC ${ac} = ${parts.join(' · ')}`,
    };
  },
  // The member's kit + remaining uses + level-availability, for the action UI.
  _kitState(m) {
    const kit = kitFor(m.cls);
    const lvl = m.level || 1;
    const boltAction = !!weaponOf(m.gear, m.weaponKey).boltAction;   // single-shot rifle → no Rapid Shot
    const maxSlots = slotsFor(m.cls, lvl, m.castingMod);
    // Stance BUTTONS only show for the style that can use them: a MELEE wielder
    // sees Power Attack, a RANGED wielder sees Deadly Aim, and pure casters (whose
    // at-will is a cantrip, not a weapon swing) see NEITHER. The full kit keeps
    // both — the bot AI manages stances from it (_botStance) and a weapon swap
    // re-serializes the right button on the next broadcast.
    const _weaponFighter = (kit.atwill || {}).effect === 'attack';
    const _rangedNow = this._isRanged(m);
    const _showStance = (ab) => !(ab.powerattack || ab.deadlyaim)
      || (_weaponFighter && (ab.powerattack ? !_rangedNow : _rangedNow));
    // Metamagic — for SPONTANEOUS casters: the toggle buttons (one per feat owned)
    // and which are active. Slot spells re-level by the active toggles below.
    const ff = fighterFeats(m.cls, m.level, this._isRanged(m));
    const mmActive = this._spontMM(m) || {};
    const mmFeats = isSpontaneous(m.cls)
      ? [['intensify', 'Intensify', '+1'], ['empower', 'Empower', '+2'], ['maximize', 'Maximize', '+3'], ['quicken', 'Quicken', '+4']]
          .filter(([k]) => ff[k]).map(([key, name, adj]) => ({ key, name, adj, on: !!mmActive[key] }))
      : [];
    return {
      // The at-will button wears the CHOSEN cantrip's face — a caster who has
      // cycled to Acid Splash or Jolt sees that name, not a stale "Ray of Frost".
      atwill: (() => {
        const at = kit.atwill;
        const a = (at && at.effect === 'bolt' && CANTRIP_BY_KEY[m.cantrip]) ? CANTRIP_BY_KEY[m.cantrip] : at;
        return { key: a.key, name: a.name, icon: a.icon, img: a.img || at.img || null };
      })(),
      caster: isCaster(m.cls),
      domainsMax: maxDomainsFor(m.cls) || 0,   // cleric 2 / inquisitor 1 / else 0 — shows the Domain picker (Phase C)
      spellNote: kit.note || null,
      metamagic: mmFeats.length ? mmFeats : null,    // null → no buttons (prepared casters bake metamagic into spell entries)
      spellPool: isPoolClass(m.cls) ? { remaining: m.spellPool || 0, max: spellSlots(lvl) } : null,
      // Per-spell-level slots for spontaneous casters: { 1: {remaining,max}, … }.
      slots: maxSlots ? Object.fromEntries(Object.keys(maxSlots).map(L => [L, { remaining: (m.slots && m.slots[L]) || 0, max: maxSlots[L] }])) : null,
      abilities: this._abilitiesFor(m).filter(ab => this._charAllows(ab, m) && this._loadoutAllows(ab, m) && _showStance(ab)).map(ab => {
        // Slot spells re-level by the active metamagic; the UI shows the effective
        // level, draws the right slot count, and greys out if there's no slot there
        // (or it pushes past 9th).
        const slvlEff = ab.cost === 'slot' ? this._slotLevelFor(m, ab) : ab.slvl;
        // allyPick: this spell can be aimed at ONE chosen ally (the sighted
        // party-card click and the blind ally-picker both set payload.allyUid;
        // the server honors it, else smart-auto-picks). True for single cures,
        // single-ally buffs, invisibility, infernal healing, and Breath of Life.
        const allyPick =
          (ab.effect === 'heal' && ab.heal === 'single') ||
          (ab.effect === 'buff' && ab.target === 'ally' && !ab.party && !ab.powerattack && !ab.deadlyaim) ||
          (ab.effect === 'invisible') ||
          (ab.effect === 'infernalheal') ||
          (ab.effect === 'domward') ||   // Protection domain's Resistant Touch aims at one ally (default self)
          (ab.effect === 'revive' && !ab.raiseDead);
        // dispelPick: Dispel Magic can be aimed at EITHER an afflicted ally or an
        // enchanted foe — the blind picker offers both sides; sighted uses the
        // party-card / enemy selection. No pick → smart auto / refuse if nothing.
        const dispelPick = ab.effect === 'cleanse';
        // modePick: a CHANNEL (heal:'party') can be aimed OFFENSIVELY (sear undead)
        // or DEFENSIVELY (heal the party) — the client prompts and sends payload.mode.
        const modePick = ab.effect === 'heal' && ab.heal === 'party';
        return {
        key: ab.key, name: ab.name, icon: ab.icon, img: ab.img || null, cost: ab.cost, target: ab.target, effect: ab.effect, allyPick, dispelPick, modePick, maxTargets: ab.maxTargets || 1,
        slot: this._abilitiesFor(m).indexOf(ab),   // stable index into kit+domain abilities (the action payload `slot`) — survives the char filter
        active: ab.effect === 'form' ? !!(m.form && ab.form && m.form.key === ab.form.key) : undefined,   // form currently shifted-into
        minLevel: ab.minLevel || 1, slvl: ab.slvl || null, slvlEff: slvlEff || null,
        available: lvl >= (ab.minLevel || 1) && !(ab.needsRepeating && boltAction) && !(ab.cost === 'slot' && (slvlEff > 9 || !(maxSlots && maxSlots[slvlEff]))), desc: ab.desc || '',
        remaining: ab.cost === 'pool' ? (m.spellPool || 0) : ab.cost === 'slot' ? ((m.slots && m.slots[slvlEff]) || 0) : ab.cost === 'room' ? ((m.abilityUses && m.abilityUses[ab.key]) || 0) : ab.cost === 'run' ? ((m.runAbilityUses && m.runAbilityUses[ab.key]) || 0) : null,
        max: ab.cost === 'pool' ? spellSlots(lvl) : ab.cost === 'slot' ? ((maxSlots && maxSlots[slvlEff]) || 0) : ab.cost === 'room' ? roomUses(ab, lvl, m) : ab.cost === 'run' ? (typeof ab.uses === 'function' ? ab.uses(lvl, m) : (ab.uses || 1)) : null,
        };
      }),
    };
  },
});
