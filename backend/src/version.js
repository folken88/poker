// Folken Poker — the ONE app version (semver). The boot log, /api/health,
// /api/version and the client topbar all read this. MANDATE (Tobias 2026-07-03):
// bump MINOR for each feature batch, PATCH for fix-only batches, and note the
// change in one line below. Newest first; keep each line short.
//
//  3.14.2 2026-07-04  FULL-CARD ART FOR EVERYONE: every monster token now
//                     pairs a /portraits/ entry (no more circular-mask
//                     fallback on fungal/charau-ka/robots/new bosses);
//                     CONSTRUCT healers REPAIR with drills (drill SFX),
//                     no more black-magic prayers from the Gearghost
//  3.14.1 2026-07-04  INSPIRE COURAGE scales per PF1 (+1/+2/+3/+4 at
//                     1/5/11/17) — Elodie at 17 sings the party to +4 hit
//                     and damage (aura + manual cast; one _inspireBonus)
//  3.14.0 2026-07-04  FILL 4: one click seats random AI until the poker
//                     table holds 4 total players (table:fillBots upTo) —
//                     the quick small-game setup. + banter variety rule
//                     (BANNED STOCK OPENERS: no more "well well look who")
//  3.13.3 2026-07-04  MONK STRIKE POOL: every monk (hero AND villain, plus
//                     the Pugilist robot and Bent-Beak) alternates bruce kiai
//                     / punisher yell / bamboo smacks per attack (MONK_SFX,
//                     11 sounds, exported from monsters.js)
//  3.13.2 2026-07-04  NEGATIVE ENERGY MENDS UNDEAD: antipaladin bots skip
//                     undead targets for Touch of Corruption/Vampiric Touch
//                     (_spellWorksOn), humans get a spoken refusal (action
//                     kept); vamp_bodyguard token recentered on his helmet
//                     (new per-monster artPos field)
//  3.13.1 2026-07-04  KAI'S BASTARD'S BLADE (fauchard: 1d10 18-20/×2 REACH,
//                     rides his DEX for hit+dmg, Improved Crit at L9+) +
//                     Josh quick wins (taunt results counts-only, RAGE line
//                     trimmed) + honest reboot toast (no more 'xhr poll error')
//  3.13.0 2026-07-04  TELEPORT TACTICS + THE THRUNE PAIR: Dimension Door/
//                     Teleport (wiz/sorc/magus) blink a melee ally —
//                     untouchable until the caster's next turn, next strike
//                     reaches ANY foe w/ full attack (bots use it on flyers);
//                     WW Deathblade spellstrikes = Inflict Critical Wounds
//                     4d8+11 (HEALS undead struck); Barzillai RAW I16 w/ +5
//                     flaming-burst mace + cover art, ALWAYS paired with
//                     Rivozair, devil-bound blue dragon (18 HD boss: 12d8
//                     lightning breath, arcane fire, her own roar as hype)
//  3.12.0 2026-07-04  HYPE TRACKS: Maestro themes extracted from the FVTT
//                     worlds play when a boss room opens (echoes to the poker
//                     table) — Kevoth-Kul/Tool, Brogwort/Backstreet, Vrood/
//                     Radiohead, Ikualo'a/roar, Saurian/gibberish. PLUS the
//                     Black Sovereign draws BURNING HATE (+5 VICIOUS
//                     greatsword: 4d6+17, 1d6 recoil/hit, disarmable,
//                     flaming-eviscerate SFX). ALL 10 imported bosses
//                     recomputed PF1-LEGIT from source-actor scores, even
//                     where OP (Kevoth +30/AC 19 raging, T-rex 4d6+16,
//                     wizard-HP wizards, Tar-Baphon paralyzing touch DC 25).
//                     ADVANCEMENT: bosses always +2..4 levels (+1-2 CR, all
//                     stats); ELITE regular spawns fill thin CR bands; boss
//                     cap 13→20 (Warden/Abrogail/Kevoth/Overlord/Amalokla/
//                     Brogwort/Tar-Baphon were unreachable!); boss marker is
//                     now a ☠️ + blood-red ring (crown = Loot Lord only)
//  3.11.0 2026-07-04  BOSS EXPANSION 8→18: Golden Saurian rename+gibberish SFX,
//                     dragons get the FULL kit (melee+arcane+divine, boss-only),
//                     ex-PCs Blackout (drow slayer, SR-25 rifle) & Ragh (orc,
//                     return-beam+mjolnir), Palace Uniques (Kevoth-Kul CN,
//                     Amalokla, Brogwort), CC canon (Vrood 14, Vorkstag 10,
//                     TAR-BAPHON W20 capstone)
//  3.10.1 2026-07-04  ART PURGE + boss enforcement: badger removed (no real
//                     token exists), goblin rogue/shaman get real tokens
//                     (Commando + cleric-priest) — 124/124 enemies have art;
//                     zernibeth & abrogail now IN BOSS_KEYS (were boss-only
//                     by comment, spawnable in fact)
//  3.10.0 2026-07-04  THE SHACKLES (task #61 batch 2): 21 imports from the
//                     03-shackletastic world — 'pirate' gang (lubber→Capt.
//                     Maris + the Fungal zombie crew), 'sahuagin' + 'charauka'
//                     warbands, bosses Ikualo'a (Huge T-rex) & Capt. Thrune
//  3.9.1  2026-07-04  POST-RESTRUCTURE AUDIT (Tobias mandate → CLAUDE.md #9):
//                     require graph + destructured exports verified clean;
//                     fixed 7 refs to nonexistent spell_invoke.mp3 (pre-cast
//                     + enemy mirror/fly/invis casts were MUTE); docs synced
//                     to the split (ARCHITECTURE/DUNGEON/AI-NOTES/map)
//  3.9.0  2026-07-04  THE MACHINES (task #61): 17 Iron Gods robots imported
//                     from the f1 Foundry world — gearsmen/drones/mechas CR
//                     1/3→17, construct gang, elec-vulnerable, repair drones,
//                     Thought Harvester holds, Scraper grab-shock-crush,
//                     Warden + Overlord bosses; tokens from foundry-media
//  3.8.2  2026-07-04  HOTFIX: 4 mixin free-variable crashes from the Phase-2
//                     split — BUFF_META (Power Attack toast, the live one),
//                     titleCase (Bane badge), PARALYZE_DC (ghoul melee),
//                     MAGUS_SPELLSTRIKE_SFX (spellstrike) + sweep test
//  3.8.1  2026-07-04  pf1core façade: src/pf1core/index.js — THE one door to
//                     the rules engine (13 concept namespaces), purity gate in
//                     the suite; PGM (pgm.folkengames.com) consumes this
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
module.exports = { VERSION: '3.14.2' };
