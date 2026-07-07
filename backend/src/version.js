// Folken Poker — the ONE app version (semver). The boot log, /api/health,
// /api/version and the client topbar all read this. MANDATE (Tobias 2026-07-03):
// bump MINOR for each feature batch, PATCH for fix-only batches, and note the
// change in one line below. Newest first; keep each line short.
//
//  3.37.15 2026-07-06 SAHUAGIN PRINCE gets ORDER OF THE FLAME — a GLORIOUS CHALLENGE mechanic.
//                     The sea-devils' crowned cavalier (already in the 'sahuagin' pack) now
//                     goes berserk on a kill-streak: every hero it DROPS lets it roar a fresh
//                     glorious challenge, stacking +2 melee damage AND −2 AC per consecutive
//                     kill THIS ROOM (compounding — a prince left to carve the party becomes a
//                     runaway threat, but ever easier to hit). Resets between rooms. Generic
//                     `gloriousChallenge` flag on the MON — ready to reuse for a future PLAYER
//                     cavalier of this order. domtest +3.
//  3.37.14 2026-07-06 JASON'S SUMMON DEVIL line (Cleric of Asmodeus) — the infernal mirror of
//                     Draymus's Summon Undead. Seven char-gated cleric spells (Summon Devil
//                     I–VII, spell levels 3–9): 1d3 IMPS → accusers → an ERINYES archer → a
//                     BONE DEVIL → 1d3 barbed/bomb devils → a HORNED DEVIL (CR16) capstone.
//                     They're called up from Hell (LE), soak hits, and fight for the party,
//                     bringing their own SR/DR/flight. The summon engine is now flavor-aware
//                     (undead claw from the grave; devils march up from Hell) and the bot
//                     summoner-opener is generic, so bot-Jason calls up his biggest devil.
//                     domtest +3.
//  3.37.13 2026-07-06 REESE NUMPAD, Josh's layout: bow functions on TOP, Imbued Shots in a
//                     SUBMENU. The blind pad is now 1 = bow attack, 2 = Deadly Aim, 3 = Rapid
//                     Shot, 4 = Bullseye Shot (just like a ranger), then 5 = IMBUED SHOTS — a
//                     submenu that lists only the shots he can use (Shocking Grasp, Frigid
//                     Touch, …); press a number to fire, Escape to back out. New shots slot in
//                     as he levels, so the top of the pad never gets crammed. (Blind client
//                     only; sighted buttons unchanged. Only reorders for a magus.)
//  3.37.12 2026-07-06 BUGFIX — REESE'S IMBUED SHOTS FIRE AGAIN (Josh: "shocking grasp / frigid
//                     touch are there but say no such attack exists"). The magus renames its
//                     spellstrikes into FRESH objects on every _abilitiesFor call, so _kitState
//                     computed each shot's action `slot` with a SECOND call's indexOf(ab) — which
//                     couldn't find those objects and handed back slot -1. Firing slot -1 hit
//                     "no such ability". Now the ability list is captured ONCE and indexOf runs
//                     against it, so every Imbued Shot resolves to its real slot and casts.
//                     (Reese-only bug — only the magus re-maps its abilities.) domtest +2.
//  3.37.11 2026-07-06 ART: the FIRE SKELETON now wears real burning-skeleton art
//                     (undead_burning_skeleton.webp) instead of the old placeholder. Also
//                     removed the ORPHANED "field-marshal-freya-kusanagi" enemy portrait —
//                     Freya's been a HERO (not an enemy) since 2026-07-05, so that art was dead
//                     and was cluttering the Crop Station. (Static art + portraits manifest.)
//  3.37.10 2026-07-06 CROP STATION: RELAXED the zoom/pan constraints (Tobias: "conchobar/crisp
//                     start so zoomed in I can't center the face — relax these fucking
//                     constraints"). You can now zoom OUT past "cover" (down to ~60% below the
//                     whole-image-fits point) and pan freely INSIDE the card, so a tight face
//                     shrinks and centers with margins. The bake was reworked to draw the image
//                     by its dest rect, so a zoomed-out crop bakes with clean transparent
//                     margins (the card backdrop) instead of stretching. Zoom-in unchanged.
//  3.37.9 2026-07-06  CROP STATION: "Save crop" now AUTO-ADVANCES to the next image (Tobias),
//                     so you can crop straight down the roster without reaching for the ▶.
//                     Wraps back to the first after the last.
//  3.37.8 2026-07-06  CROP STATION remembers your framing (Tobias: "I crop it, save, close,
//                     reopen — and it's uncropped again"). The save ALWAYS worked (the crop was
//                     baked into the card), but the EDITOR reset to the whole original every
//                     time, so it LOOKED lost. Now Save also stores the crop framing (a
//                     normalized `.webp.crop` sidecar) and reopening the editor RESTORES it —
//                     you land on your last crop and can tweak from there. Cropped images get a
//                     ✓ in the picker. Non-destructive as ever (the .orig is still the source).
//  3.37.7 2026-07-06  NEW AI-HERO AZWRAITH + construct-repair fix. AZWRAITH: a Hell's Rebels
//                     human FIGHTER built around a REACH FAUCHARD and TRIPPING. His whole game
//                     is the fighter's Trip — sweep a foe prone (it LOSES its turn) and land a
//                     FREE attack; that free strike is the engine's stand-in for his Combat-
//                     Reflexes reach AoO (this gridless engine has no literal opportunity
//                     attacks). Bot-Azwraith auto-trips the biggest still-standing, trippable
//                     foe each turn, then cleaves (Cleave early, from L4) and confirms crits
//                     with Improved Critical (L8, PF1-correct). Voice: Sean (the id Femmik just
//                     vacated). Art: the full-plate glaive-master portrait. CONSTRUCTS REPAIR
//                     ONLY CONSTRUCTS (Tobias): a Gearghost/repair-drone's drills & welders can
//                     no longer "mend" an organic ally, living OR dead — the healer target
//                     filter now gates construct repair to machine allies. domtest +6.
//  3.37.6 2026-07-06  VOICES (user picks): FEMMIK → "Henry - Charming Pro" (a smooth, cocky
//                     charmer — fits the Ifrit fire-dancer; was Sean). CELEB → "Daniel"
//                     (steady, authoritative BRITISH broadcaster, middle-aged male — suits the
//                     Nethys scholar-cleric; was the American "Adam"). Both 11labs voice-id
//                     swaps in bot/character_voices.js.
//  3.37.5 2026-07-06  FEMMIK CARD ART FIX (Josh): his hero card showed the tiny round token
//                     instead of his full portrait. The blue-coat portrait was already at
//                     /portraits/femmik.webp, but the portraits MANIFEST listed only
//                     "femmik-embersword" — so portraitFor("femmik") (his avatar base) missed
//                     and fell back to the token. Added "femmik" to portraits/manifest.json;
//                     his card now shows the Ifrit-in-the-blue-coat art. (Static manifest.)
//  3.37.4 2026-07-06  REESE NUMPAD DECLUTTER (Josh): level-LOCKED abilities no longer eat blind
//                     numpad numbers. Reese at L4 had his not-yet-usable Imbued Shots (Vampiric
//                     Touch, Forceful Strike, Polar Ray) burying Rapid Shot & Bullseye Shot off
//                     the pad. Now the blind action list only numbers what you can actually use;
//                     locked abilities still show in the sighted bar (greyed 🔒) and the X
//                     progression view, so nothing is hidden — they just don't clutter the pad
//                     until unlocked. Helps every character, not just Reese. (Client-only.)
//  3.37.3 2026-07-06  CHAIN-HOOK GRAB SFX (Josh): every metal chain-hook grapple — the Slorr's
//                     barbed chain AND the Gearsman Scraper's rail-hook (plus any future chain
//                     grappler) — now yanks its victim in with a "come here!" chain-rattle
//                     (slorr_come_here_grapple_chain.mp3). The grab plays the chain; each foe's
//                     own sound stays its CRUSH/constrict noise (the Scraper's live current, the
//                     Slorr's grapple line). Great over the new flyer-yank line from 3.37.2.
//  3.37.2 2026-07-06  JOSH BUG BATCH. (1) INVISIBLE HEROES NO LONGER TURTLE: a normal-
//                     invisible hero who isn't a sneak-attacker used to hide "for the right
//                     moment" that never came — Femmik (bard) & Savage (bloodrager) sat
//                     invisible & idle at 80-90% HP for whole rooms while the party got
//                     mauled. Now, after any worthwhile hidden support action, they BREAK
//                     COVER AND FIGHT; the opening blow catches the foe unseen (denies its
//                     Dex — which also fixes a latent gap where sneak heroes weren't getting
//                     that bonus from normal invisibility). (2) ENEMY NAME "+N" GONE: an
//                     advanced foe read as "Elite Deathblade Monk +3" — the raw level count
//                     is noise (Josh); now just "Elite …"/"Boss: …" (the levels still drive
//                     the stats). (3) ADVANCED-CR FLOAT FIXED: a CR-1/3 creature made Elite
//                     showed "CR 1.3333333333333335" in the inspector — now rounded ("1.33").
//                     (4) FLYER-HOOK CLARITY: a grounded mech's chain-hook that yanks a flying
//                     hero down now SAYS so ("the chain snatches them out of the air") — Josh
//                     couldn't tell how a non-flying Scraper grappled his airborne Olbryn.
//  3.37.1 2026-07-06  DANGER'S BOW is an ORCISH WARBOW: base damage 2d6 (was a 1d8 composite
//                     longbow), ×3 crit. An exotic hornbow, but Danger is trained with it
//                     (custom weapon → always proficient). Weapon key stays 'longbow' so his
//                     saved weapon row survives the rename.
//  3.37.0 2026-07-06  SIGNATURE-WEAPON QUALITIES, round 2 (Josh's roster question). Named
//                     blades now carry the magic their owners describe, always on: ROVADRA
//                     (Dismas's dragon-rifle) is a FLAMING BURST gun that's "a little bit
//                     holy" — +1d6 fire/shot, +2d10 fire on its ×4 crit, +1d6 vs evil.
//                     VOIDSHARD (Ulfred) is FREEZING BURST — +1d6 cold, +2d10 cold on a
//                     crit. CHAINSAW (Tokala), CURATOR (Gaspar), BASTARD'S BLADE (Kai) and
//                     the ELVEN CURVED BLADE (Toche) are KEEN. TWIN BATTLEAXES (Farrus) are
//                     UNHOLY (bite the good). GHOST TOUCH (Vesorianna) is FROST. New rider
//                     tiers: FROST BURST (extra cold on a crit) + GRADED holy/unholy (a
//                     weapon can be "a little" holy — 1d6 — not just the full 2d6). RADIANCE
//                     (Vaughan) stays element-free by design: she's a SENTIENT blade (voice
//                     "Tresdin", reincarnated at his side) who is always ≥+1 and scales with
//                     his magus levels + gear — the arcane pool already handles that. Her
//                     banter is a future feature. domtest +6.
//  3.36.0 2026-07-06  REESE archery feat-track + WHISPERING WAY undead summoning. A BOW
//                     magus now climbs the RANGER archery ladder on top of his magus
//                     metamagic core — Point Blank Shot, Rapid Shot, Bullseye (and
//                     Manyshot up high) as passives, plus the RAPID SHOT + BULLSEYE SHOT
//                     actions (Reese "always shoots"). A melee magus is unchanged. And the
//                     WHISPERING WAY casters (Gravecaller, Necromancer, Death Priest,
//                     Archnecromancer) now RAISE UNDEAD reinforcements onto their own side
//                     — real foes, front-loaded then an occasional fresh wave — the enemy
//                     mirror of Draymus's Summon Undead (_enemySummon). domtest +6.
//  3.35.0 2026-07-06  REESE / MAGUS rework (Josh's confusing "SS …" list). Spell Strikes
//                     are now ONE clean entry per spell that AUTO-SCALES with the magus's
//                     metamagic feats — the 4 redundant metamagic variants (SS Max SG /
//                     SS Emp SG / SS Max! / SS Emp Vamp) are gone (the feats already apply
//                     via _mmForCast). Kept + clearly named: Shocking Grasp (L1) → Frigid
//                     Touch (L4) → Vampiric Touch (L7) → Forceful Strike (L10) → POLAR RAY
//                     (L13, new). Each is named by DELIVERY: a bow magus (Reese) fires an
//                     "Imbued Shot: <spell>", a melee magus a "Spell Strike: <spell>". They
//                     unlock slowly like real spellstrike, and the same touch spell works
//                     for melee OR ranged (Eldritch-Archer house rule).
//  3.34.2 2026-07-06  FLAILS are now STR-only 2H (join axes & hammers as brute weapons).
//                     RESET-TO-LEVEL-1 button RESTORED: the "↺ Reset to Lv 1" control was
//                     wired in the client + server but the BUTTON was missing from the
//                     page (Josh & Toby couldn't find it). Added it beside your class /
//                     weapon on the character bar — clear label, danger tint, and a real
//                     <button> with an aria-label so VoiceOver's item chooser surfaces it.
//                     Busts your current class back to L1 (keeps gear, gold, other classes).
//  3.34.1 2026-07-06  FINESSE HOUSE RULE extended to 2H (Tobias): free Weapon Finesse +
//                     Slashing/Fencing Grace now covers MOST two-handed weapons too —
//                     greatsword, glaive, fauchard, quarterstaff, spears, polearms,
//                     estoc… swing off the BETTER of STR/DEX for hit & damage (×1.5
//                     preserved). Only BRUTE 2H — the AXE and HAMMER weapon groups —
//                     stay strength-only. (weapon.finesse2h/str2h override per-weapon.)
//  3.34.0 2026-07-06  WEAPON REFINEMENTS + JASON'S FORCE PUSH (user picks). Freya's
//                     Balrog's Blessed Blade upgraded to FLAMING BURST. Femmik's Lammas
//                     and J'Mal's Sawtooth Sabers now ALSO carry CRITICAL FOCUS (+4 to
//                     confirm crits) on top of keen (new weapon.critFocus prop; J'Mal's
//                     blades already ride his DEX for hit & damage via the 1h house
//                     rule). Jason's FORCE PIKE is no longer unholy — it's a plain magic
//                     weapon PLUS a new FORCE PUSH ability (Dota Force-Staff style,
//                     3×/room): shove a foe and EVERY melee ally with their weapon out
//                     (melee'd within the last round) gets a FREE attack; Jason forgoes
//                     his own strike. Bot-Jason force-pushes when 2+ melee allies are
//                     ready. domtest +4.
//  3.33.1 2026-07-06  Draymus's voice: DRACULA (11labs, user pick) — the dhampir
//                     necromancer now speaks with a cold, aristocratic menace.
//  3.33.0 2026-07-06  SUMMONING Phase 2 — the summons now SOAK: an enemy's melee can
//                     swing at a summoned undead instead of a hero (mixed into its
//                     random target pool; resolved as an enemy-vs-summon blow, the
//                     dominate-kin pattern). Drawing fire is half the point of raising
//                     them. Plus PF1 SUMMON NUMBERS: each Summon Undead raises the PF1
//                     count — 1 (I), 1d3 (II), then 1d4+1 (III–IX) — of a CR-appropriate
//                     undead, with ONE kind picked at random from the choices at that CR
//                     (no extra player step). So Summon Undead V = 1d4+1 CR-3 undead,
//                     IX = 1d4+1 CR-8/9 undead, etc. domtest updated.
//  3.32.0 2026-07-06  SUMMONING SYSTEM (experiment) — Draymus's SUMMON UNDEAD I–IX: a
//                     Summon Monster line that raises UNDEAD to fight for the party.
//                     Summoned minions ride in the enemy array flagged ALLIED — they
//                     take turns striking real foes, render in the PARTY ROW (green ☠️
//                     card, not targetable by the party), don't block room-clear, and
//                     crumble after ~rounds/level. New SKELETAL OGRE (CR 6) fills the
//                     undead CR gap. Draymus prepares one summon at EVERY spell level;
//                     bot-Draymus opens a fight by raising his strongest undead. Char-
//                     gated signature spells are now always castable by their character.
//                     PHASE 1: foes don't yet target the summons back (no soak) — next
//                     pass. domtest +7.
//  3.31.0 2026-07-06  DRAYMUS the NECROMANCER — a playable dhampir wizard AI-hero
//                     (Agent of the Grave, author of the Mortiari Manifesto). New
//                     DHAMPIR race (+2 Dex/+2 Cha/−2 Con, darkvision 60, negative
//                     energy heals). He wields the ANGELBONE SCYTHE (2d4 ×4, unholy —
//                     bites the good). As a necromancer SPECIALIST he gets a char-gated
//                     death arsenal a normal wizard lacks: CHILL TOUCH + ENERVATION
//                     (new negative-energy touch spells) + SLAY LIVING, on top of the
//                     wizard's own death spells (darkness, cloudkill, finger of death,
//                     horrid wilting, wail of the banshee). FUTURE: a summoning system
//                     so casters can raise fodder to the battlefield. domtest +7.
//  3.30.0 2026-07-06  SIGNATURE WEAPON QUALITIES: named blades now carry their own
//                     magic INTRINSICALLY — always on, no matter the wielder's class,
//                     level or +N tier (the +N still rides the in-game gear). Gabriel's
//                     REDEEMER is flaming burst + holy; Freya's Balrog's Blade flaming;
//                     Femmik's Lammas & J'Mal's Sabers keen; Jason's Force Pike unholy
//                     (bites the Heavenly Host); Reese's Stormcaller shock. New weapon
//                     riders: shock (+1d6 elec) & frost (+1d6 cold), routed through the
//                     foe's resistances like flaming. J'MAL'S DRAGON SHIELD: a bashing
//                     heavy shield he attacks WITH — two swings a round AND he keeps his
//                     shield AC (+2, unlike a normal dual-wielder). CLIENT: a character's
//                     signature weapon now shows on the sheet as "★ Redeemer (flaming
//                     burst · holy)" instead of a blank slot (Josh's report). domtest +7.
//  3.29.0 2026-07-06  CHARACTER BATCH (1 hero + 7 foes): SAVAGE — a playable
//                     tiefling BLOODRAGER (greataxe; cleave + magic-fueled Rage +
//                     a self Bloodline Surge; slow spell progression), voice Sanjay,
//                     zoomer-brute banter. Seven new enemies: the HEAVENLY HOST gains
//                     Angel Bro (Erelim CR8), two aasimar gunslingers (twin PISTOLS
//                     CR10 ranged; a SHOTGUN CR10 that scatters the whole party), an
//                     angel field-CLERIC (CR11, big channel healing), an angel
//                     CAVALIER knight (BOSS CR14), and CHAD — an aasimar PALADIN
//                     champion (BOSS CR17) swinging THE GOLDENROD (+5 holy 2H hammer,
//                     3d6+18). Plus SOIRSE — a succubus BARD boss (CR10, CE) whose
//                     Dominate is modeled as Hold Person (DC 20). Movanic Deva art
//                     refreshed. All wired into every MON map (gang/art/type/align/
//                     boss/natural) + domtest coverage.
//  3.28.6 2026-07-06  DEFLECTION bonuses modeled: Shield of Faith is now a deflection
//                     bonus — it stacks with armor + Mage Armor but takes the HIGHER
//                     vs a Ring of Protection (they don't stack), and the caster bot
//                     no longer wastes a cast when it grants no AC increase (e.g.
//                     Celeb, who has a +2 ring). Itemized in the AC tooltip.
//  3.28.5 2026-07-06  Reese token cache-bust: the token art was swapped under the
//                     same /tokens/reese.webp URL, so browsers kept the old cached
//                     image (even on hard refresh). His avatar URL is now
//                     /tokens/reese.webp?v=2 so it re-fetches. (Server image was
//                     always correct — a blue winged Strix archer.)
//  3.28.4 2026-07-06  CELEB Mage Armor fix: _preDoorBuffs + run-ability stocking
//                     used kitFor(m.cls), which for a Theurge is the fighter
//                     DEFAULT_KIT (no Mage Armor) — so Celeb never auto-cast Mage
//                     Armor and fell back to Shield of Faith. Both now use his real
//                     ability list (celebKit). Also: new Reese token/portrait art.
//  3.28.3 2026-07-06  BLIND ACCESS fix: the only dungeon entry ("Hit the Dungeon")
//                     was buried in the opacity:0 role="dialog" bank popover, which
//                     VoiceOver's item chooser can't surface — Josh couldn't find
//                     any way in. Added always-present sr-only "Enter the Dungeon" /
//                     "Spectate the Dungeon" buttons (client-static). Sighted button
//                     unchanged. LESSON: never bury a mode's sole entry in a hidden dialog.
//  3.28.2 2026-07-05  BANTER anti-repeat: linePool.choose never replays the same
//                     bark twice in a row for a (char,kind) — a one-line pool now
//                     rerolls fresh instead of parroting (Reese said the same
//                     line 3× in a row). Also de-tersed Reese's persona (his
//                     "clipped, few words" prompt was collapsing the LLM output).
//  3.28.1 2026-07-05  VOICES: Binch → Tresdin (was Grace). The Tresdin trio (Freya,
//                     Sirona, Binch) now shares a SURLY/GRUMPY/FIRM delivery tuning
//                     (steadier, less theatrical, a touch slow) + Binch reworked to
//                     a cantankerous, easily-annoyed old Besmara sea-dog.
//  3.28.0 2026-07-05  CELEB unarmored defense: he wears no armor but adds BOTH his
//                     DEX and his WIS modifier to AC (monk-like, Nethys balance),
//                     stacking with his auto-cast Mage Armor. (Mage Armor was
//                     already a L1 arcane spell in his kit + auto-cast pre-fight.)
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
module.exports = { VERSION: '3.37.15' };
