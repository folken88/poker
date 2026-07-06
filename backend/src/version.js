// Folken Poker — the ONE app version (semver). The boot log, /api/health,
// /api/version and the client topbar all read this. MANDATE (Tobias 2026-07-03):
// bump MINOR for each feature batch, PATCH for fix-only batches, and note the
// change in one line below. Newest first; keep each line short.
//
//  3.27.2 2026-07-05  VOICES (user picks): Femmik=Sean, Freya=Tresdin, J'Mal=Ultron,
//                     Jason=Okole, Reese=Felix. Also fixed Sirona → Tresdin (was Sarah).
//  3.27.1 2026-07-05  FLIGHT vs CONTROL fix: a corporeal flyer that is HELD
//                     (paralyzed / Hold Person) or GRAPPLED (Black Tentacles &c.)
//                     is dropped/dragged down — grounded melee can now reach it
//                     (_canReach + the enemy target filter). Real wings (Reese)
//                     still beat DISPEL, but not control. Incorporeal ghosts
//                     (Vesorianna) still drift out of reach.
//  3.27.0 2026-07-05  DUNGEON QoL + class/hero pass: (1) new SETTINGS action
//                     "Reset helpers to my level" — lowers AI helpers DOWN to the
//                     invoking human's level (never up; gear & gold untouched).
//                     (2) CAVALIER now fully selectable, with its CHALLENGE feature
//                     (name a foe → +cavalier level bonus damage vs it this room);
//                     Freya is now a Cavalier. (3) FIRE + LAW domains added; Jason
//                     now runs Fire+Law (was Trickery+War). (4) New AI-hero REESE —
//                     a Strix Eldritch-Archer MAGUS: INNATE undispellable flight
//                     (real wings) + spellstrike through his bow "Stormcaller".
//                     Added the Strix race. (Heroes already start L1 with no gear.)
//  3.26.0 2026-07-05  TWO VILLAIN FACTIONS imported from the Hell's worlds, each
//                     its OWN gang (they never share a room). HELL'S LEGIONS
//                     (gang 'devil', fills the low-mid CR gap): Imp (CR2), Accuser
//                     (CR3), Erinyes (CR8 archer), Bone Devil (CR9), Horned Devil
//                     (CR16 boss), Pit Fiend (CR20 boss). THE HEAVENLY HOST (new
//                     gang 'celestial', GOOD-aligned so hero Smite Evil misses):
//                     Hound Archon (CR4), Bralani Azata (CR6 ranged), Lillend
//                     Azata (CR7 support/heal), Movanic Deva (CR10), Ghaele Azata
//                     (CR13 boss), Astral Deva (CR14 boss). Real Foundry art.
//  3.25.0 2026-07-05  HELL'S VENGEANCE/REBELS PCs → 4 PLAYABLE AI-HEROES (real
//                     Foundry builds): Femmik Embersword (Ifrit Dawnflower Dervish
//                     bard — new BATTLE DANCE: his Inspire Courage is self-only &
//                     DOUBLED; DEX-finesse scimitar "Lammas Aeternum"), Freya
//                     Kusanagi (half-elf Samurai/Hellknight, flaming katana),
//                     J'Mal (hobgoblin Red Mantis Assassin/Rogue, twin sawtooth
//                     sabers), Jason (tiefling Cleric of Asmodeus, reach force
//                     pike, trickery/war domains). Added Ifrit + Hobgoblin races.
//                     REMOVED the old freya/jason/jmal ENEMY stat blocks (they're
//                     heroes now, not villains).
//  3.24.0 2026-07-05  SLAYER Studied Target (Stage 2, completes the class): a
//                     SWIFT/free-action mark on ONE foe — every attack the slayer
//                     makes against it gains +N insight to hit AND damage
//                     (N = 1 + 1 per 5 levels → +1/+2/+3/+4/+5 at 1/5/10/15/20).
//                     Re-study any turn to switch marks; clears each room. Bonus
//                     mirrors Smite in _swingVsAC; the slayer bot auto-studies its
//                     prey. Kai Ginn now marks his quarry.
//  3.23.2 2026-07-05  Reporting pass 3 (Josh): cut the DR FLUFF — the once-
//                     per-fight reveal is now terse "DR 10/magic" (was "…only an
//                     enchanted weapon bites through / rely on spell damage"),
//                     and the per-hit "−N DR" tag is gone everywhere (DR still
//                     soaks; the reduced number speaks for itself). Blind TURN
//                     PROMPT restored to "Your turn." + the terse enemy list
//                     (name, N of M HP, flying) so he can numpad-target — I'd
//                     over-trimmed it to just "Your turn."
//  3.23.1 2026-07-05  Reporting pass 2 (Josh, mostly client/live): blind TURN
//                     PROMPT is now just "Your turn." (no HP/enemy/spell dump —
//                     he uses H/E/?); the quick TARGET LIST is name + HP + flying
//                     only, with CR moved into the E-inspector (enemyDesc). Plus:
//                     the CR-16 devil-rogue '???' (unspeakable for TTS) is now
//                     the "Nameless Horror". (Still open: segmented S, rage trim,
//                     dominated-foe turns.)
//  3.23.0 2026-07-05  CONSISTENT/SUCCINCT REPORTING (Josh) — pass 1: dropped HP
//                     totals from every attack line (enemy→hero hits, damage
//                     spells, spellstrikes, missiles, rays) — text AND TTS now
//                     read "X hits Y for N", no "(45/80)"; the rogue Sneak rider
//                     reads "(+21 sneak)" (base vs bonus clear, no die count);
//                     TAUNT now reports grouped counts like every other
//                     multi-target result. (More passes: turn prompt, terse
//                     target list, segmented S, rage-desc trim, dominated foes.)
//  3.22.0 2026-07-05  CELEB STAGE 2 — SPELL SYNTHESIS (Kobold Press): a limited
//                     number of times per room (1/2/3 at L5/11/17) he casts ONE
//                     arcane + ONE divine spell in a single turn. His AI lines up
//                     the pair by consulting his own brain once per school, so he
//                     favors party buffs (two of them) or a buff + a debuff. The
//                     pair lands at −4 to enemy saves / +4 caster level vs SR.
//  3.21.0 2026-07-04  FLANKING (Tobias): once a SECOND melee ally joins the same
//                     foe, both flank it — +2 to hit, and Sneak Attack turns on
//                     for rogue-likes (Kelda + Kai). The first to close gets
//                     nothing (moved up alone); tracked per-room on the foe.
//  3.20.0 2026-07-04  SLAYER is a playable class (ACG, ranger+rogue) — Stage 1:
//                     now human-selectable, DEX-finesse build, and Kai Ginn is a
//                     Slayer. He already had the chassis (d10/full-BAB/good
//                     Fort+Ref), martial weapons, an 8-ability maneuver kit, and
//                     Sneak Attack (SNEAK_CLASSES) — this wires it up. Studied
//                     Target (swift per-foe mark) lands in Stage 2.
//  3.19.3 2026-07-04  Theurge spellbook fix: the loadout system has no 'theurge'
//                     KIT, so Celeb's Spellbook pool read EMPTY at every level
//                     (looked like "no level-1 spells"). _loadoutModel/_rebucket
//                     now source his injected celebKit for the display; his
//                     in-combat casting was already correct.
//  3.19.2 2026-07-04  Theurge PREP SPLIT: Celeb's casts each spell level are now
//                     HALF arcane / HALF divine (two pools). Spells on BOTH class
//                     lists (Dispel Magic, Prot. Evil, Hold Person…) are 'both' —
//                     they fill whichever half he needs and their save DC rides
//                     his BETTER stat. Non-theurges keep one shared pool.
//  3.19.1 2026-07-04  Theurge fix: the runtime cleric kit carries a `channel`
//                     ability that leaked into Celeb's union — skip it (a
//                     theurge does NOT channel energy).
//  3.19.0 2026-07-04  CELEB IS A THEURGE (Kobold Press 3pp) — Stage 1: dual
//                     arcane+divine PREPARED caster on the true d6/½-BAB chassis
//                     (glass cannon, no armor). His kit is the UNION of the real
//                     cleric (divine, WIS DCs) + wizard (arcane, INT DCs) lists —
//                     the widest spell selection in the game, buff/dispel-forward
//                     (Tim's playstyle). Dual-stat DCs via per-spell dcStat. NO
//                     channel, NO domains (he isn't a cleric). Spell Synthesis
//                     (double-cast) lands in Stage 2.
//  3.18.1 2026-07-04  ART FIX + POLICY: the v3.17.1 "remove token-* files"
//                     also stripped 63 HERO-AVATAR tokens the picker uses —
//                     un-archived; pruned 3 dead manifest entries (Clenchjaw/
//                     Kelda Rogue/Nigel). NEW asset standard (Tobias): keep
//                     full art, just webp + max 1920 wide — downscaled 48
//                     oversized portraits to 1920w and converted the last 2
//                     PNGs (gabriel, form_tiger) to webp (DB kit_json + refs).
//  3.18.0 2026-07-04  CROP STATION made NON-DESTRUCTIVE (after the earlier
//                     display bug caused silent repeat-saves that baked 215
//                     portraits down to 570×600): all 216 restored from their
//                     .orig. Now the editor ALWAYS loads the pristine original
//                     (new /api/croporig serves the .orig), Save bakes the crop
//                     at the ORIGINAL's NATIVE resolution (no downsample, no
//                     compounding), and the zoom floor is "fill" (no confusing
//                     letterbox — the game card always covers). Re-crop anything
//                     forever; the original is never touched.
//  3.17.3 2026-07-04  CROP STATION zoom-out floor = "contain" (SUPERSEDED by
//                     3.18.0's fill floor): scrolling out stopped at the whole
//                     image fitting instead of shrinking into a void
//  3.17.2 2026-07-04  GEARGHOST grounded: the haunted war-chassis is a HEAVY
//                     mech, NOT a flyer — flight removed, reprofiled slow/tanky
//                     (Large, 4-legged, HP 45→60, one 1d10+6 spectral slam,
//                     Fort↑/Reflex↓) keeping its weird powers (DR 10/magic +
//                     poltergeist kin-repair) plus a new glitch-wail (fear DC 15)
//  3.17.1 2026-07-04  Zombie → GHOUL ANTIPALADIN (Antipaladin 13 risen as a
//                     ghoul: paralysis, Touch of Corruption drain, dread aura,
//                     channels negative for undead). CROP-SAVE FIX: editor now
//                     cache-busts the background so saves stick + reflect;
//                     zoom-out bakes grey letterbox. token-* art archived,
//                     abrogail-thrune-ii removed.
//  3.17.0 2026-07-04  TWO NEW AI HEROES: BINCH (Cleric of Besmara —
//                     Trickery[new domain]+Liberation, older-woman voice) and
//                     CELEB (Cleric of Nethys — wears NO armor, wields arcane
//                     Stoneskin/Overland Flight/Dimension Door/Teleport his
//                     brethren lack). NEW Trickery domain (Copycat power).
//  3.16.0 2026-07-04  ROSTER SURGERY: ghast→Ghoul Crusader (fallen Shining
//                     Crusade cleric-ghoul), gargoyle→Mecha Gargoyle (Unity
//                     construct, elec-vuln), medusa→3 classed medusa-kin
//                     (archer/swashbuckler/sorceress, Shudderwood), Port Peril
//                     Kingsguard (F12), Vampire Monk (Mnk17), NEW Hellknight
//                     warband Freya(F15 +5 flaming katana)/Jason(Asmodean
//                     cleric)/Jmal(hobgoblin rogue, 8d6 sneak)
//  3.15.0 2026-07-04  CROP STATION: settings-menu panel — pick any card
//                     image (enemy portraits + hero tokens), drag/scroll to
//                     reframe inside a live dungeon-card preview (name, HP
//                     bar, level, AC), Save bakes the crop server-side
//                     (/api/croplist + /api/cropsave; first save keeps .orig;
//                     NEW ./public:/app/public volume)
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
module.exports = { VERSION: '3.27.2' };
