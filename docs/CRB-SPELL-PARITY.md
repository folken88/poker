# CRB Spell Parity Ledger

Toby (2026-08-26): "make a plan and begin working on it to include all core
rulebook spells into the game... let me know if you think a spell is
impractical for our game and why. do 5 spells at a time until we have full CRB
parity."

Toby's confirmed parity rules (2026-08-26):
1. The spell should be as similar to PF1 as it can be.
2. The appropriate casters must have access — class list, domain, specialty or
   known home rule — BOTH prepared and spontaneous.
3. The spell may be adapted to fit the game's format (adaptations named in the
   spell's own description).

v3.37.130 ran the first RULE-2 COVERAGE AUDIT over batch 1 + the expansions and
delivered ten owed entries: inquisitor Silence (Inq 2) + Command (Inq 1),
oracle Obscuring Mist, wizard/sorcerer Heroism (3) + Irresistible Dance (8),
druid True Seeing (7) + Freedom of Movement (4) + Mass Cure Moderate (7), bard
Hold Person (2) + Mass Cure Moderate (6). Every future batch closes with the
same audit.

Ground rules for every port (the standing spell-import checklist):
- PF1 numbers wherever the dungeon can hold them; adaptations are named in the
  spell's own description.
- Range decides targeting: personal → self, touch → ally, close+ → enemy/aoe.
- Duration decides persistence: rounds/min-per-level → room; ≥10 min/level →
  dungeon-long (Toby's tier ruling).
- Wire all four points: SPELL def, per-class injection at the PF1 unlock level,
  post-override normalization if a baked copy exists, PRIORITY so bots cast it.

Status legend: ✅ in game · 🔧 adapted (note says how) · 📋 queued (batch #) ·
🚫 impractical (reason).

## Already in game (CRB unless noted)

Acid Arrow, Air Walk, Banishment, Bane→(as Doom-adjacent debuffs), Barkskin,
Bear's Endurance, Bless, Blindness/Deafness (blind half), Breath of Life (APG),
Bull's Strength, Burning Hands, Call Lightning (+Storm), Cat's Grace, Chain
Lightning, Charm Person, Chill Touch, Circle-of-Death-family→(Undeath to
Death), Cloudkill, Command→(batch 1), Cone of Cold, Cure line (Light→Critical +
Mass line), Darkness, Darkvision (Communal, UC), Daze Monster, Delayed Blast
Fireball, Dimension Door, Disintegrate, Dispel Magic (+Greater), Displacement,
Divine Favor, Divine Power, Dominate Person/Monster, Doom, Enervation, Enlarge
Person, Entangle, Fascinate(bard song), Finger of Death, Fireball, Fire Shield,
Fire Snake (APG), Fire Storm, Flame Blade, Flame Strike, Flesh to Stone, Fly,
Foresight, Freedom of Movement, Freezing Sphere, Giant/Righteous Might, Glitterdust,
Grease, Greater Magic Weapon, Gust of Wind, Haste, Heal (+Mass), Heroism
(+Greater), Hideous Laughter, Hold Person (+Mass), Hold Monster (+Mass), Holy
Smite, Horrid Wilting, Implosion, Invisibility (+Greater, Vanish), Invisibility
Purge, Irresistible Dance, Lightning Bolt, Mage Armor, Magic Fang, Magic
Missile, Magic Vestment, Maze, Meteor Swarm, Mind Blank, Mirror Image, Miracle,
Overland Flight, Polar Ray, Power Word Blind/Stun/Kill, Prayer, Prismatic
Spray, Protection from Energy (fire), Protection from Evil (Communal), Raise
Dead, Ray of Enfeeblement, Ray of Frost, Resurrection, Sanctuary→(Judgement:
Protection analog) [recheck], Scorching Ray, Searing Light, See Invisibility,
Shield, Shield of Faith, Shocking Grasp, Shout, Slay Living, Sleep, Sleet
Storm, Slow, Sound Burst, Spiritual Weapon, Stinking Cloud, Stoneskin
(+Communal), Storm of Vengeance, Suffocation (APG), Suggestion (Mass), Summon
Monster IV/VI/VIII, Summon Nature's Ally IV/VI/VIII, Sunbeam, Sunburst,
Teleport, Time Stop, True Seeing, Vampiric Touch, Wail of the Banshee, Waves of
Exhaustion, Wish, Word-of-Chaos-family→partial.

## Batch 1 (v3.37.129) — control & anti-caster

1. **Obscuring Mist** (Clr/Drd/Wiz 1) 🔧 — rides the magical-darkness system:
   foes in the bank of fog are shrouded (lose turns stumbling, concealment)
   exactly like Darkness. Adaptation: it targets the ENEMY side's air, not a
   point in space (no grid).
2. **Silence** (Brd 2/Clr 2) 🔧 — Will save or the foe is wrapped in silence
   for caster-level rounds: enemy CASTERS cannot cast (they fall back to
   weapons, announced), holds and heals included. Adaptation: single-target
   (no 20-ft emanation without a grid); the anti-Tech-Witch tool.
3. **Ray of Exhaustion** (Wiz 3) 🔧 — one foe is EXHAUSTED (one action a turn,
   −1 hit/AC), the single-target little brother of Waves of Exhaustion.
   Adaptation: auto-hit, no save (the Waves machinery); undead/constructs immune.
4. **Bestow Curse** (Clr 3/Wiz 4) 🔧 — Will save or −4 on attacks for the rest
   of the room. Adaptation: the "−6 to an ability score" and "50% lose turn"
   variants collapse into the attack-penalty curse (the one that matters here).
5. **Command** (Clr 1) ✅ — Will save or the foe FALLS PRONE and loses its
   turn ("Fall!"). Mind-affecting, language-dependent: mindless undead and
   constructs ignore it.

## Batch 2 — walls & zones (v3.37.146) ✅

Toby's mechanic (2026-08-31): while a wall or zone stands, melee foes can reach
at most TWO per target each round, the party cannot be flanked or sneak-attacked,
and each wall adds its own rider on the foes that press through. One wall per
room, level rounds (max 10), never carries between rooms. Flyers cross it,
archers shoot over it, ghosts drift through it.

1. **Wall of Fire** (Wiz/Sor 4, Drd 5) ✅ — presses through: 2d6 + CL fire.
2. **Wall of Ice** (Wiz/Sor 4) ✅ — breaks through: 1d6 + CL cold.
3. **Wall of Force** (Wiz/Sor 5) ✅ — impassable: cap ONE per target, no rider.
4. **Web** (Wiz/Sor 2) ✅ — Reflex or stuck fast (turn lost).
5. **Solid Fog** (Wiz/Sor 4) ✅ — foes inside swing at −2 to hit and damage.

Deviation (documented): PF1 walls are geometry (length, height, line of
effect); ours is the attacker cap + the rider, which is what the geometry buys
you in practice. Web's 10 min/level would be dungeon-long under the duration
rule, but a wall is bound to a room's geometry — room-scoped on purpose.

## Batch 3 — fear & the mind (v3.37.153) ✅

New conditions per PF1: FRIGHTENED / PANICKED (the foe flees — it loses its turns
while the panic holds — and is shaken, −2), CONFUSED (the book's d100 table each
turn: 1-25 acts, 26-50 babbles, 51-75 hurts itself 1d8 + Str, 76-100 attacks its
nearest ally), FEEBLEMINDED (Int/Cha 1 — no casting for the room). All are
mind-affecting: the undead and constructs are immune.

1. **Cause Fear** (Brd/Clr/Sor/Wiz 1) ✅ — one foe of 5 HD or less (CR ≤ 5
   here), Will or frightened 1d4 rounds; a made save shakes it a round.
2. **Scare** (Brd/Sor/Wiz 2) ✅ — one foe per three levels (max 6), same effect.
3. **Fear** (Brd 3, Sor/Wiz 4) 🔧 — the cone is the field (no grid): up to six
   foes, Will or panicked one round per level (max 10); a made save shakes.
4. **Confusion** (Brd 3, Sor/Wiz 4) 🔧 — the burst is up to four foes, Will or
   confused one round per level (max 10); the table is RAW.
5. **Feeblemind** (Sor/Wiz 5) 🔧 — Will (arcane casters −4) or no casting for
   the room; "permanent" collapses to the room, and the skill/language loss
   has no surface here.

## Batch 4 — divine staples (v3.37.154)

1. **Deeper Darkness** (Clr/Sor/Wiz 3) 🔧 — rides the darkness system: 1d4+2
   random foes, 3 rounds, and ordinary darkvision does NOT pierce it (True
   Seeing / blindsense only). Snuffs a Daylight in the room (PF1's level duel).
2. **Daylight** (Brd/Clr/Drd/Sor/Wiz 3) 🔧 — lifts every magical darkness on
   the field and blocks lesser darkness for the room. Not sunlight (no undead
   burn, RAW). Honest note: no foe casts darkness today, so it is a counter
   waiting for its foe.
3. **Neutralize Poison** (Brd 4/Clr 4/Drd 3/Pal 4/Rgr 3) 🚫 — the engine has
   no poison condition to cure (poison exists only as a damage type the undead
   ignore). Revisit with the first poisoning monster.
4. **Remove Blindness/Deafness** (Clr 3, Pal 3) 🔧 — cures blindness, any
   source, no check (PF1). Deafness has no surface here. (Remove Paralysis was
   found living ONLY on the druid — the cleric's copy was a dead kit literal —
   so it now has a real entry on cleric 2, oracle and paladin 2, and needs no
   check, RAW. The druid's home copy stays.)
5. **Harm** (Clr 6) ✅ — touch, 10/level negative energy (max 150), Will half;
   the undead are healed by it, and the bots know never to aim it at them.

Death Ward moved to batch 5 (wards).

## Batch 5 — condition removal & wards (v3.37.155)

1. **Remove Curse** (Brd 3/Clr 3/Pal 3/Sor-Wiz 4) ✅ — lifts a curse, no check
   (PF1). To give it a curse to lift, CL5+ enemy casters now cast **Bestow
   Curse** once a room (3rd, Will negates): a failed save is −4 to hit and on
   saves and CLINGS from room to room until Remove Curse — Dispel cannot touch
   it (RAW). Bots cast Remove Curse for a cursed ally; the Remove spells never
   aim at a foe.
2. **Remove Fear** (Brd 1/Clr 1) 🔧 — lifts fear-born shakenness (Daunting
   Success is the only hero sickening) and wards the party for the run: immune
   to Daunting Success, +4 on saves vs fear gazes. Adaptation: the whole party,
   not one creature per four levels.
3. **Spell Resistance** (Clr 5) ✅ — SR 12 + CL on an ally for the room; every
   enemy SPELL (blast, nuke, missiles, hold, curse) rolls d20 + CL against it.
   Racial SR and the spell take the higher (SR never stacks). Hold Person now
   tests SR too — it never did.
4. **Lesser Globe of Invulnerability** (Sor/Wiz 4) / **Globe of
   Invulnerability** (Sor/Wiz 6) 🔧 — enemy spells of 3rd / 4th level or lower
   cannot reach anyone inside for the room: Fireball, Magic Missile, Hold
   Person, Bestow Curse, plain Dispel Magic. Cone of Cold, Chain Lightning,
   Hold Monster, Greater Dispel, Disintegrate and Finger of Death pass. The
   lich stops throwing fireballs at a globed party and reaches for the nuke.
   Adaptation: the whole party huddles inside (PF1: a 10-ft emanation).
5. **Death Ward** (Clr 4/Drd 5/Pal 4) ✅ — a Finger of Death fails outright; a
   vampire's draining touch lands only its weapon part and drinks nothing.
6. **Restoration / Lesser Restoration** (Clr 4/2, Drd 5/3, Pal 4/1) 🚫 — heroes
   never suffer fatigue, exhaustion, ability damage or negative levels (only
   FOES are fatigued, by Waves of Fatigue), so there is nothing to restore.
   Revisit with the first energy-draining monster.

## Batch 6 — clouds & phantasms (v3.37.156)

1. **Acid Fog** (Sor/Wiz 6) 🔧 — rides the wall system as a Solid Fog with a
   bite: melee cap 2, no flanking, foes wading through swing at −2, and every
   round-top it eats 2d6 acid into every foe on the field. Adaptation: the fog
   covers the whole field (PF1: a 20-ft spread).
2. **Incendiary Cloud** (Sor/Wiz 8) 🔧 — the same frame with smoke: 4d6 fire
   to every foe each round, Reflex half (the wall's DC). A cloud that clears
   the room ends the fight at round-top (Dungeon.js round-top now checks
   `_endIfResolved` after the wall tick).
3. **Phantasmal Killer** (Sor/Wiz 4) ✅ — Will to disbelieve (no effect), then
   Fortitude or DIE of fright; a made Fortitude save still takes 3d6. Mind-
   affecting + death effect: the mindless and the unliving are immune (the bot
   gate `_spellWorksOn` knows). A boss never drops outright — a failed Fort is
   half its max HP, the standing savedie boss rule.
4. **Weird** (Sor/Wiz 9) 🔧 — Phantasmal Killer on up to 6 foes; a made
   Fortitude save takes 3d6 and STUNS a round (PF1's 1 Str damage has no
   surface here).
5. **Contagion** (Clr 3/Drd 3/Sor-Wiz 4) 🔧 — Fortitude negates, or the foe is
   DISEASED for the rest of the room: sickened + fatigued (−3 to hit and
   damage, −1 AC and Reflex, −2 on saves). Undead and constructs do not sicken.
   Adaptation: PF1's diseases deal ability damage over days; here the onset is
   immediate and the effect is the two conditions the engine already tracks.

## Batch 7 — the summon ladder (v3.37.157)

Pool data only, on the standing rule (Toby, v3.37.125): the bestiary's own
beasts, celestial-touched or wild, never evil. Every rung now exists.

1. **Summon Monster I / II / III / V / VII / IX** (Brd I–VI; Clr/Orc/Sor/Wiz
   I–IX) ✅ — I: one dire rat / giant centipede / giant spider; II: 1d3 of one
   kind; III: a dire ape; V: a basilisk or a lioness; VII: a dire bear or a
   chimera; IX: a movanic deva or Ikualo'a. IV/VI/VIII gain a hound archon, a
   bralani azata and an erelim angel (PF1's outsiders on those rungs).
2. **Summon Nature's Ally I / II / III / V / VII / IX** (Drd I–IX; Rgr I–IV
   from level 4) ✅ — the same beasts, wild-flavored, no outsiders; IX is
   Ikualo'a itself.
3. Fixed in passing: the summon-turn log called every non-devil summon "your
   undead" — a celestial lioness rending a foe now reads as "your celestial",
   a wild beast as "your beast", and they fade rather than crumble to dust.

4. Bot rule that came with the rungs: a puny summon (SM I's rat at level 10) must
   not outrank a heal — the opener now needs a pool CR worth a third of the
   toughest foe. Summoner-style casters (Jason, Draymus) call help regardless.

Honest gaps: the bestiary has no CR-2 beast (SM II is 1d3 of the CR-1 tier,
which PF1 allows) and no elemental or eagle; the rungs use what exists.

## Batch 8 — tricks & save-or-suffer (v3.37.158)

1. **Blink** (Brd/Sor/Wiz 3) 🔧 — self, room: 50% of attacks that would hit
   you miss (it shares Displacement's gate, so True Seeing pierces it — the
   adaptation) and 20% of your own attacks flicker away (RAW). An enemy Dispel
   can rip it. The ethereal side (walls, incorporeal touch) has no surface.
2. **Repulsion** (Clr 7, Sor/Wiz 6) ✅ — up to 8 foes, Will negates, or for
   1 round/level a melee-only foe cannot close: its turn is spent straining at
   the field. Archers and casters shoot and cast over it (RAW: it stops
   bodies, not spells).
3. **Insanity** (Sor/Wiz 7) ✅ — Will negates, or CONFUSED for the rest of the
   room (PF1 permanent). Rides the v3.37.153 confusion table. Mind-affecting.
4. **Baleful Polymorph** (Drd/Sor/Wiz 5) 🔧 — Fortitude negates, or the foe is
   a harmless rabbit for the room: AC 12, a 1d3 nibble, no spells, no flight,
   no bow; HP stay (PF1's Con swap has no surface). The original block is kept
   on the foe for the log. A boss is too mighty to unmake (the standing
   save-or-lose boss rule); the bot gate knows.
5. **Gaseous Form** (Brd 3/Sor-Wiz 3) 🚫 — a hero who cannot attack or cast
   has no turn to take in this format; PF1's uses (slipping through cracks,
   scouting) have no surface. Revisit if a "retreat/regroup" verb ever exists.
6. **Spider Climb** (Drd 2/Sor-Wiz 2) 🚫 — no walls or ceilings to climb; it
   would be a cheaper Fly. The engine's only "height" is flying.
7. **Dimensional Anchor** (Clr 4/Sor-Wiz 4) 🚫 — no enemy teleports, blinks or
   plane-shifts today, so there is nothing for the anchor to stop. Revisit
   with the first teleporting foe (a bone devil's teleport would be the one).

## Batch 9 — cages & words (v3.37.159)

1. **Forcecage** (Sor/Wiz 7) 🔧 — PF1's windowless-cell option: no save, no
   SR, one foe (a boss too) sealed for 1 round/level — untargetable and turn-
   less, like Maze, then free and furious. The barred-cage option (attacks
   through the bars) has no surface. Bots don't cast it yet, like Maze.
2. **Holy Word / Blasphemy / Dictum / Word of Chaos** (Clr 7) 🔧 — every foe
   NOT of the word's alignment reels, no save, SR applies, on the PF1 ladder by
   HD vs caster level: above CL untouched; equal → deafened; ≤ CL−1 → blinded
   2d4; ≤ CL−5 → paralyzed (10 rounds); ≤ CL−10 → slain (a boss loses half
   its max HP instead — the standing rule). Adaptations: CR stands in for HD;
   deafness has no surface, so that tier RATTLES (sickened 1d4); heroes carry
   no alignment, so any cleric may speak any of the four (PF1 would forbid a
   good cleric Blasphemy). The banishment clause has no extraplanar surface.
3. **Earthquake** (Clr 8, Drd 8) 🔧 — up to 8 foes, 8d6 (PF1's cavern result),
   Reflex half, and a failed save throws a grounded foe PRONE. Adaptation: the
   caster shapes the quake around the party; fissures/collapse are the 8d6.
4. **Binding** (Sor/Wiz 8) 🚫 — a days-long ritual of permanent imprisonment
   with no combat surface.
5. **Symbol family** (Symbol of Death/Fear/Insanity/Pain/Persuasion/Sleep/
   Stunning/Weakness) 🚫 — glyphs left for later intruders; the dungeon has
   no "later" and no intruders but the party. Revisit only if rooms ever get
   a trap-setting phase.

## Batch 10 — clones & staples (v3.37.160)

The straggler sweep, part 1: 43 spells that ride effects the engine already
had. Every entry is on its PF1 class list at its PF1 level.

1. **Inflict Light/Moderate/Serious/Critical Wounds** (Clr 1-4) ✅ and **Mass
   Inflict** (Clr 5-8) ✅ — negative energy, Nd8 + CL (capped), Will half,
   SR applies; the undead are healed by it. (Inflict on an undead ALLY as a
   heal has no cast path yet — the touch line targets foes; noted.)
2. **Magic Weapon** (Clr/Pal/Sor-Wiz 1) ✅ — a flat +1 enhancement; never
   stacks with Greater Magic Weapon / Greater Magic Fang (same bonus type).
   **Greater Magic Fang** (Drd/Rgr 3) ✅ — run-long, +1 per 4 CL (max +5).
3. **Charm Monster** (Brd 3, Sor/Wiz 4) ✅, **Mass Charm Monster** (Sor/Wiz
   8) ✅, **Suggestion** (Brd 2, Sor/Wiz 3) 🔧 (the charm mechanics stand in
   for the suggestion). RAW fix in passing: **Charm Person** now reaches
   HUMANOIDS only — it reached every living creature before.
4. **Deep Slumber** (Brd/Sor-Wiz 3) 🔧 — up to 5 foes (the count stands in
   for the HD budget). **Dismissal** (Clr 4, Sor/Wiz 5) ✅ — one outsider.
   **Greater Command** (Clr 5) ✅ — up to 5. **Lesser Confusion** (Brd 1) ✅ —
   one round. **Greater Shout** (Brd 6, Sor/Wiz 8) ✅ — 10d6 + stun on a
   failed save. **True Resurrection** (Clr 9) 🔧 (as Resurrection; the
   no-body clause has no surface). **Regenerate** (Clr 7, Drd 9) 🔧 (4d8 + CL
   heal; limbs have no surface).
5. **Fog Cloud** (Drd/Sor-Wiz 2) 🔧 — rides the darkness rules like
   Obscuring Mist. **Faerie Fire** (Drd 1) 🔧 — reveals the invisible, no
   save (no foe has blur/displacement to negate).
6. **Hypnotism / Hypnotic Pattern / Rainbow Pattern** (Brd 1/2/4, Sor-Wiz
   1/2/4) 🔧 — fascinate with a Will save; 1 / 3 / 5 foes stand in for the
   HD budgets.
7. **Invisibility Sphere** (Brd/Sor-Wiz 3) ✅ and **Mass Invisibility** (Sor/
   Wiz 7) 🔧 — the whole party, each unseen until they strike (the area
   difference has no surface).
8. **Mass Enlarge Person** (Sor/Wiz 4) ✅, **Mass Bear's / Bull's / Cat's**
   (6th on their lists) ✅. **Eagle's Splendor / Fox's Cunning / Owl's
   Wisdom** (2nd) and the **Mass** versions (6th) 🔧 — +4 to the stat is
   modeled as +2 to spell DCs and spell attacks for casters of THAT stat; on
   anyone else it has no surface (no skill checks here).
9. **Energy Drain** (Clr/Sor-Wiz 9) 🔧 — 1d4/level (max 16d4) negative
   energy; PF1's negative levels have no surface (Enervation's precedent).
10. **Chaos Hammer / Order's Wrath** (Clr 4) ✅ — the PF1 alignment table:
    opposed foes take it all (+ slowed 1d6 / dazed a round on a failed save),
    neutral half, same-aligned untouched; the bot gate skips the same-aligned.
    OPEN for Toby: Holy Smite and Unholy Blight predate this table and still
    hit everyone — see TOBY-QUESTIONS #8.
11. **Bane** (Clr 1) 🔧 — Will negates, or −1 to hit, damage and saves for
    the room (rides the Prayer penalty; PF1's is −1 attacks and −1 vs fear).
    **Aid** (Clr 2) 🔧 — +1 hit, +1 saves (PF1: vs fear), 1d8+CL temp HP.
    **Rage** (Brd 2, Sor/Wiz 3) ✅ — party morale rage. **Limited Wish** (Sor/
    Wiz 7) 🔧 — one ally back / 10d8+15 mending / a lighter wound, never an
    unmaking.
12. **Protection from Chaos / Good / Law** (1st) and the four **Magic Circles**
    (3rd) 🔧 — FOLDED into Protection from Evil (Communal): the ward here is
    +2 AC / +2 saves against everything, so four alignment copies would only
    stack the same bonus; one entry covers them all (named in its desc later).

## Batch 11 — wards (v3.37.161)

The straggler sweep, part 2: 28 hero-side wards, each a new mechanic.

1. **Blur** (Brd/Sor-Wiz 2) ✅ — 20% incoming miss through Displacement's
   gate (True Seeing pierces it; an enemy Dispel rips it).
2. **Entropic Shield** (Clr 1) ✅ — enemy ranged attacks miss you 20%.
3. **Protection from Arrows** (Sor/Wiz 2) ✅ — DR 10 vs ranged weapons from a
   10/CL pool (max 100), PF1's DR 10/magic (no foe here fires magic arrows).
4. **Wind Wall** (Clr 3, Drd 2, Rgr 2, Sor/Wiz 3) ✅ — a field effect of its
   own: enemy arrows, bolts and thrown weapons are flung aside for 1 round/
   level (max 10); spells and melee pass. It coexists with a standing wall.
5. **Sanctuary** (Clr 1) 🔧 — untargetable until you attack or cast at a foe.
   PF1 gives each attacker a Will save; here the ward simply holds.
6. **True Strike** (Sor/Wiz 1, Magus 1) ✅ — +20 on the next attack roll.
7. **Keen Edge** (Sor/Wiz 3, Magus 3) ✅ — doubled threat range, rides the
   magus keen flag (no stacking with Improved Critical).
8. **Bless Weapon** (Pal 1) 🔧 — crits vs evil auto-confirm; the DR/good clause
   has no surface (no foe carries DR/good).
9. **Resist Energy** (Clr/Drd/Pal/Sor-Wiz 2, Rgr 1) ✅ ×5 — one entry per
   energy type (fire, cold, acid, electricity, sonic): 10/20/30 per hit by
   CL. **Protection from Energy** (Clr/Drd/Sor-Wiz 3, Rgr 2) ✅ ×4 — typed
   12/CL pools (fire already existed as Protection from Fire). One energy
   soak now serves every type (resistance first, then the pools).
10. **Shield Other** (Clr/Pal 2) 🔧 — half of an ally's wounds land on the
    caster for the room (PF1: 1 hour/level, +1 AC/saves — the share is what
    matters here).
11. **Spell Turning** (Sor/Wiz 7) 🔧 — the next 3 enemy spells aimed at you
    fizzle (PF1 reflects 1d4+6 spell levels at the caster; the reflection has
    no surface).
12. **Cloak of Chaos / Holy Aura / Shield of Law / Unholy Aura** (Clr 8) 🔧 —
    party +4 AC, +4 saves and SR 12+CL for the room; PF1 keys them to the
    opposed alignment and adds a blinding/mind-shield rider (no surface). The
    four share one stack slot.
13. **Transformation** (Sor/Wiz 6) ✅ — +2 hit/damage, +4 AC, +2 HP/level, and
    no spells until the room ends; bots never cast it (botAvoid).
14. **Antilife Shell** (Clr/Drd 6) ✅ — living melee foes cannot close on the
    caster: they turn on another ally or strain at the shell.

## Queued (batches of 5, in priority order)

- **Batch 12 — offense (new mechanics):** Color Spray, Scintillating Pattern,
  Crushing Despair, Mind Fog, Ghoul Touch, Halt Undead, Resilient Sphere,
  Circle of Death, Song of Discord, Eyebite, Mage's Sword, Flaming Sphere,
  Produce Flame, Wall of Thorns, Spike Stones, Prismatic Wall, Mage's
  Disjunction, Poison, Rusting Grasp, Shatter, Telekinesis, Whirlwind, Death
  Knell, Break Enchantment, Animate Dead, Control Undead.
- Then the last 🚫 pass (self-polymorphs, Gate, Elemental Swarm, Summon
  Swarm, Insect Plague, Fire Seeds, Stone to Flesh, Spell Immunity, Touch of
  Idiocy, Moment of Prescience, Hide from Undead, Calm Emotions, the Shadow
  family, Reduce Person, Expeditious Retreat, Shillelagh, Magic Stone, Blight,
  Animal Growth) with reasons.

## Impractical (🚫) — and why

These families don't survive contact with a room-based, grid-less, sight-free
dungeon crawl with no NPCs, no downtime and no overworld. Each can be revisited
if the game grows the surface it needs.

- **Divination/knowledge:** Identify, Detect Magic/Thoughts/Snares, Augury,
  Divination, Commune (+Nature), Contact Other Plane, Find the Path, Legend
  Lore, Locate Object/Creature, Scrying (+Greater), Arcane Eye, Clairvoyance,
  Prying Eyes, Vision, Discern Location, Stone Tell, Speak with
  Dead/Plants/Animals, Tongues, Comprehend Languages, Read Magic — nothing
  offscreen to learn; the dungeon has no hidden facts these could return.
  (True Seeing/See Invisibility made the cut because piercing illusions IS a
  combat verb here.)
- **Travel & escape:** Plane Shift, Ethereal Jaunt/Etherealness, Shadow Walk,
  Astral Projection, Word of Recall, Teleportation Circle, Transport via
  Plants, Tree Stride, Phase Door, Passwall, Find Steed/Mount, Phantom Steed —
  there is nowhere else to go; rooms connect by one door. (Dimension Door /
  Teleport made the cut as combat repositioning per Toby's rulings.)
- **Social & NPC:** Enthrall, Zone of Truth, Discern Lies, Modify Memory,
  Geas/Quest, Mark of Justice, Demand, Sympathy/Antipathy, Forbiddance,
  Sending, Whispering Wind, Animal Messenger, Ventriloquism, Magic Mouth,
  Illusory Script, Secret Page — no NPCs to talk to, fool, or bind.
- **Downtime, crafting & camp:** Fabricate, Minor/Major Creation, Wall of
  Stone/Iron as construction, Move Earth, Stone Shape, Secure Shelter, Rope
  Trick, Magnificent Mansion, Instant Summons, Permanency, Guards and Wards,
  Hallow/Unhallow, Consecrate/Desecrate, Continual Flame, Make Whole, Mending,
  Alarm, Fire Trap, Glyph of Warding (+Greater), Explosive Runes, Sepia Snake
  Sigil, Symbol family (maybe batch 9 as combat traps), Snare, Spike Growth/
  Stones as area denial (borderline — could join a walls batch), Plant Growth,
  Diminish Plants, Control Water/Weather, Reverse Gravity (borderline combat —
  revisit), Binding, Trap the Soul, Soul Bind, Clone, Simulacrum, Animate
  Dead (Draymus already owns this space as a character kit), Create Undead
  (+Greater), Magic Jar, Reincarnate ✅ (already in, druid).
- **Object-target:** Animate Rope, Arcane Lock, Knock (doors open free here),
  Erase, Shatter (borderline — could be a Sunder analog), Shrink Item, Warp/
  Wood family, Soften Earth, Rusting Grasp (borderline vs constructs —
  revisit), Grease ✅ made it long ago.
- **Sight/light micro-management:** Dancing Lights, Light, Flare, Daylight
  (batch 4 as counter-darkness), Hypnotic Pattern/Rainbow Pattern (fascinate
  exists as the bard song), Silent/Minor/Major Image and the whole figment
  school — the engine has no scenery to fake; Mirror Image/Displacement/
  Invisibility already cover combat illusion.
- **Cantrips (0-level):** covered by the at-will system (each caster has a
  real at-will attack); porting 0-levels individually adds noise, not choices.
- **Self-polymorph misc:** Alter Self, Polymorph family beyond the druid forms
  and Elemental Body already in — revisit if Toby wants arcane shapeshifters.

## Process

One batch per release alongside Josh's bugfixes; each batch updates this
ledger in the same commit. Bots learn every spell that enters PRIORITY;
descriptions teach every adaptation; domtests pin each batch.
