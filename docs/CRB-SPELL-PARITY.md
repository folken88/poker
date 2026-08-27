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

## Queued (batches of 5, in priority order)

- **Batch 2 — walls & zones:** Wall of Fire, Wall of Ice, Wall of Force, Web,
  Solid Fog.
- **Batch 3 — fear & the mind:** Cause Fear, Fear, Scare, Confusion,
  Feeblemind.
- **Batch 4 — divine staples:** Death Ward, Silence… (moved to 1) → Deeper
  Darkness, Daylight, Neutralize Poison, Remove Blindness/Paralysis (cleanse
  pass), Harm.
- **Batch 5 — condition removal & wards:** Restoration (+Lesser), Remove
  Curse, Remove Fear, Spell Resistance, Globe of Invulnerability.
- **Batch 6 — blasts & rays:** Acid Fog, Incendiary Cloud, Phantasmal Killer,
  Weird, Contagion.
- **Batch 7 — summon fill:** Summon Monster I–III/V/VII/IX + Nature's Ally
  gaps (pool data only).
- **Batch 8 — movement & tricks:** Blink, Gaseous Form, Spider Climb,
  Dimensional Anchor, Repulsion.
- **Batch 9 — save-or-suffer:** Baleful Polymorph, Insanity, Symbol family
  (as room-trap casts?), Forcecage, Binding→likely 🚫.
- **Batch 10 — the holy words:** Holy Word, Blasphemy, Dictum, Word of Chaos,
  Earthquake.
- Then a sweep of stragglers until the ledger shows no 📋.

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
