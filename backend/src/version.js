// Folken Poker — the ONE app version (semver). The boot log, /api/health,
// /api/version and the client topbar all read this. MANDATE (Tobias 2026-07-03):
// bump MINOR for each feature batch, PATCH for fix-only batches, and note the
// change in one line below. Newest first; keep each line short.
//
//  3.8.0  2026-07-04  Phase-2 COMPLETE — seam 4: HERO-ABILITIES mixin (attacks,
//                     every _ab* handler, pickers, spell math, SR — 2,686
//                     lines) to game/dungeon/abilities.js. Dungeon.js is now
//                     2,675 lines: turn loop + rooms + party + bot AI only
//  3.7.5  2026-07-04  concept split: pf1data/feats.js — feat trees, gating +
//                     *_FEAT_AT tables out of Dungeon.js module scope (pure
//                     pf1core, PGM-shared); Dungeon 5,697 → 5,325 lines
//  3.7.4  2026-07-04  Phase-2 seam 3: ENEMY-AI mixin — the whole villain brain
//                     (_monsterSwing/_enemyAct/maneuvers/caster brains/
//                     _detonate, 28 methods) moved VERBATIM to
//                     game/dungeon/enemyAI.js (factory: tuning consts)
//  3.7.3  2026-07-03  dispel ECONOMICS (bards fight/buff/heal too — foe-dispel
//                     only for spell-Fly/Invis/Haste-tier, never AC wards;
//                     peel order high-value-first) · Melee/Ranged attack
//                     buttons (mode param; bow+Melee refused turn kept)
//  3.7.2  2026-07-03  Dispel Magic = SPELL effects only (PF1, Tobias): clears
//                     spell-hold/slow/blindness; grapple/stun/sickness/nausea
//                     are physical and stay; Remove Paralysis frees ANY
//                     paralysis (even ghoul Su) + slow; bots pick accordingly
//  3.7.1  2026-07-03  Phase-2 seam 2: SERIALIZE mixin — publicState + cond/buff
//                     strips + _kitState/_heroACs/_xpInfo moved VERBATIM to
//                     game/dungeon/serialize.js (factory: takes fighterFeats)
//  3.7.0  2026-07-03  Phase-2 restructure seam 1: LOOT mixin — drops/roll-offs/
//                     equip/hock/potions + loot tuning moved VERBATIM to
//                     game/dungeon/loot.js (Object.assign onto the prototype)
//  3.6.0  2026-07-03  PF1 SPELL RESISTANCE: devils/demon + vampire court CR8+
//                     carry SR (11+CR-ish); hero spells test d20+CL(+Spell Pen)
//                     per target (slot spent on failure, AoE tallies); drow
//                     heroes (Olbryn) get SR 6+level vs enemy spells; AI skips
//                     unbeatable SR; supernatural gazes/shouts/channel exempt
//  3.5.3  2026-07-03  Chain Lightning joins the SND.lightning rotation (the
//                     Hetfield one-off stays on Storm of Vengeance)
//  3.5.2  2026-07-03  hero-card names left-justified (clear the face) ·
//                     Inspire Courage waits for the FIRST door (was singing
//                     at character selection) · Dismas real art (3.5.1 tail)
//  3.5.1  2026-07-03  PF1 spell DCs: 10 + SPELL level + mod (was 10 + CASTER
//                     level — L17 Chain Lightning read DC 37, now ~23) ·
//                     bots sear-channel only vs 2+ undead, paladins never
//  3.5.0  2026-07-03  class-progression reference (Josh): 'progression' action
//                     + blind X key — next-9-levels gains from _levelGains
//  3.4.0  2026-07-03  Domains Phase C: Domain picker — sighted "⛪ Domains ▾"
//                     panel + blind V menu (toggle picks, cap-enforced, lands
//                     next room) · cleric domain SPELLS join the castable set
//  3.3.2  2026-07-03  Selective Channeling codified for all channelers (feat
//                     tables + descs); undead-court priests burst-mend ALL
//                     wounded undead allies selectively (living spared)
//  3.3.1  2026-07-03  AI uses domain powers: bot 1d stage (ward/rage/bleed vs
//                     real fights, once/room) · enemy priests get Healer's
//                     Blessing (CR5+) + Death Priest/Vampire Priest Bleeding
//                     Touch (heroes bleed 1d6/turn until magically healed) ·
//                     Surge/Rage tightened to ONE swing/hit per PF1
//  3.3.0  2026-07-03  Domains Phase B: runtime granted powers — Liberation pool
//                     (level rounds/room, auto), Strength/War/Luck/Protection/
//                     Death actives (3+Wis/room, injected into the action list),
//                     Healing/Sun passives; hardcoded inquisitor FoM replaced
//  3.2.1  2026-07-03  Hold Person humanoid-only (PF1 RAW, Tobias's call) —
//                     _isHumanoid gate + AI knowledge + kit descs
//  3.2.0  2026-07-03  enemy metamagic parity (lich/arcane blasts+nukes Empower
//                     CL12+/Maximize CL16+, once each per room) · Slow now −1
//                     Reflex (both sides) · prone attacker −4 melee
//  3.1.1  2026-07-03  lightning SFX rotation trimmed (Mjolnir→thrown-weapon
//                     reserve, umbral bolt→umbral spells) per Josh/Tobias
//  3.1.0  2026-07-03  versioning formalized · wave-2 spells (Sunburst/Prismatic/
//                     Waves of Exhaustion/Banishment/Greater Heroism/Mass
//                     Suggestion/inq Greater Dispel) · Domains Phase A data
//  3.0.x  ≤2026-07-03 the informal "v3" era (see git history)
module.exports = { VERSION: '3.8.0' };
