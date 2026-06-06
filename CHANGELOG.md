# Folken Poker — Patch Notes

A running log of notable changes, and credit to the people whose ideas shaped them.
(Entries before this file existed are reconstructed from memory, so dates are
approximate and some early tweaks are grouped by theme rather than listed one-by-one.)

## Credits

Thanks to the regulars whose suggestions made it into the game:

- **Cram** — the **"my turn" sound cue**. A chime plays on your client when the
  action reaches you, so you never miss your turn even if you've tabbed away.
- **Timmay** — the **between-rounds delay**. A short pause after each hand (with a
  little extra grace when a seat opens) so players can **join or leave between
  rounds** without interrupting a hand in progress.
- **Josh** — the **blind-support overhaul**. A long-time screen-reader user whose
  feedback shaped the spoken play-by-play, push-to-talk voice commands, barge-in,
  and accessible seating.

---

## 2026-06-06 (newest)

### 🐾 Druids & Wild Shape
- **Druids now shapeshift for combat.** New **Wild Shape forms** — toggle on/off, each
  usable **once per room**, lasting until you change back:
  - **Tiger Form** — dire-tiger: claws + bite (3 attacks), +2 hit, +4 dmg, +1 AC.
  - **Bear Form** — dire-bear tank: 3 attacks, +2 hit, +4 dmg, +3 natural-armor AC, +2 HP/level.
  - **Hawk Form** — **fly** out of reach of grounded foes (and still cast spells from the air).
- **Rissa's forms are her own:** she shares **Hawk Form**, but in place of Tiger/Bear she
  gets — **Beast Mode** (the **Beast of Lepidstadt**: LARGE, +3 hit, +6 dmg, **DR 10/adamantine**,
  swats flyers out of the sky — roars *What Could Have Been*) and **Promethean** (a
  multi-tentacled horror: **15-ft reach** that hits flyers, **4 attacks**, and every hit
  **GRAPPLES** the foe helpless until it breaks free — bellows *Dragon-Roar*).
- **Shillelagh** — every druid's signature club (1d10, ×2, blunt).
- **Expanded druid spell list:** buffs (**Barkskin, Iron Skin** DR 10, **Magic Fang, Bull's
  Strength, Bear's Endurance, Cat's Grace**), offense (**Entangle** — roots a random **2d4**
  foes, **Lightning Bolt, Shocking Grasp, Call Lightning**), and restoration (**Cure Light/
  Moderate, Remove Paralysis, Dispel Magic**).
- Engine: long-reach / winged natural weapons can now strike **airborne** foes; a hit from a
  grappling weapon seizes the foe; multi-natural-attack routines (also fixes Crisp the
  deinonychus) all swing at full strength.

### ⚜️ Paladin free actions
- **Detect Evil** and **Smite** activation are now **free actions** — flipping them
  on no longer eats your turn, so a paladin can mark the room (or light up a smite)
  and still attack the same round. (Smite already worked this way; Detect Evil was
  the one consuming the turn.)

### 🗡️ Exotic one-handers for warriors (home-rule)
- **Full-BAB and 3/4-BAB classes** (fighters through rogues, clerics, oracles —
  everyone but the 1/2-BAB arcane casters) now wield one-handed **exotic blades**
  like the **bastard sword** and **katana** as if they had Exotic Weapon
  Proficiency: **no −4 penalty**, and one-handed so they **keep their shield**.
  Wizards and sorcerers still take the penalty.
- **Bastard Sword** (1d10, 19–20) added to the weapon dropdown.

### 📖 Curator — Gaspar's bastard sword
- Gaspar's named blade **Curator** quickens the **first buff spell each turn** to a
  **swift action** — cast it for free and still take your real action (a second buff
  or a strike). In effect, a Curator-wielder can stack **two buffs in one turn**.

## 2026-06-05

### ⚔️ Two-weapon fighting & PF1 iterative attacks
- **Iterative attacks** — when a hero **full-attacks the same target as last turn**,
  they add extra swings as their BAB grows (**−5** at BAB 6, **−10** at 11, **−15**
  at 16). Switch targets and you get just your base swing. Resets each room.
- **Dual-wielders** get the full treatment. **Lou Candlebean** is now a **fighter**
  swinging a **gnome hooked hammer** (a double weapon → 2 swings); **Farrus** (twin
  axes) and **rogues** (Nomkath → kukri, Kelda → dagger; rogue default is now the
  dagger) all dual-wield.
- **Two-weapon feats on the feat ladders** — Two-Weapon Fighting (cuts the dual
  penalty to −2), Two-Weapon Defense (+1 AC while two-weapon fighting), and Improved
  Two-Weapon Fighting (an extra off-hand swing). **Barbarians** now earn the fighter
  feat ladder on **odd levels** (like the inquisitor), so Farrus gets them too.

### 🛡️ Gear & UI
- **Magic items are generic** — drops and the Loot Bank now say **+N Weapon / Armor /
  Shield** (the bonus rides on whatever your class actually wields).
- **Everyone starts with masterwork armor** for their class (no more free chain
  shirt): heavy classes a Full Plate (AC 9), medium (barbarian, **oracle**) a
  Breastplate (6); arcane casters wear none. +N magic armor adds on top.
- **Hero cards show current AC** (🛡 N, top-right) at a glance on the battleboard.
- **The recruit-AI picker centers on screen** (it used to run off the top), scrolls
  if long, and dismisses on outside-click/Escape — alongside the 🎲 Random helpers
  button.
- **The audio-settings menu is now on the dungeon screen too** (the same control as
  the poker topbar).

### 💨 Buffs & sound
- **Haste lasts 1 round per caster level** (PF1) and clears at room end like other
  buffs — we use PF1 buff durations throughout.
- **Slain heroes forfeit their gold** share on the way out (the living and dying
  split it); **cure potions** now play the cure sound; **Blessing of Fervor** shouts
  ABBA's "Gimme! Gimme! Gimme!"

### ⚜️ Paladin overhaul
- **Spellcasting from level 1** (home-rule) — paladins (and antipaladins) no longer
  wait until 4th for spells; their slow progression just starts at 1st. New spell
  level every 3 character levels: **Shield of Faith (1)**, **Bull's Strength (4)**,
  **Prayer (7)**, **Blessing of Fervor (10)**, one casting each per room. *(Same
  home-rule onset is intended for bloodragers when they get a kit.)*
- **Hero's Defiance** — when a paladin is dropped to 0 HP or below (but not slain),
  on their turn they **refuse to fall**: a lay-on-hands heal auto-fires, putting
  them back on their feet. Once per room.
- **A fighter-feat tree on odd levels** — **L1 Toughness**, **L3 Power Attack** (the
  free on/off toggle), then **L5 Weapon Focus**, L7 Dodge, L9 Weapon Specialization,
  L11 Improved Initiative, L13 a save feat, L15 Improved Critical, L17 Critical
  Focus, L19 Improved Cleave. Each folds into the paladin's combat math.

### 💨 Haste, Blessing of Fervor & buffs
- **Haste now grants its full PF1 package** — the extra attack **plus +1 to hit, +1
  dodge AC, and +1 Reflex**, active only while hasted. It can't stack with itself,
  and stacks cross-type with other buffs (its dodge AC adds to Shield of Faith's
  deflection AC, etc.).
- **Blessing of Fervor** now works for **clerics, oracles, and inquisitors** (and
  paladins at 10) — granting the **haste extra attack** (its haste choice). It
  incants **ABBA's "Gimme! Gimme! Gimme!"** (one of three clips). It does NOT grant
  Haste's +1s — that's the Haste spell's job.
- **Shield of Faith (and the other single-ally buffs)** no longer waste a re-cast on
  an ally who already has the buff — they pick the next-most-vulnerable ally instead.

### 🩹 Dungeon fixes
- **Slain heroes forfeit their gold.** A hero who is **dead** (not merely downed)
  when the party leaves gets **no share** of the run's gold; the living and the
  dying split it.
- **Cure spells heal the most-hurt ally who isn't dead** — including the **downed**
  (a cure can now pull a bleeding-out ally back to their feet), instead of skipping
  them for someone barely scratched.
- **Random helpers** — a 🎲 button hires up to 3 random AI allies at 50g each, as
  many as you can afford (150g → 3, 100g → 2, 50g → 1).
- **You can't be in two places at once** — taking a poker seat pulls you out of any
  dungeon run, the table won't seat a bot who's delving, and a human who takes over
  an AI character now keeps the table "occupied" so it keeps dealing. Delvers also
  get **↩ Leave** and **🛑 Cancel run** buttons.
- **Agu** is pronounced "ag-yew."

### 🔮 New class — the Oracle
- **Oracles** join the dungeon roster: a **spontaneous divine** caster on the
  **cleric spell list** (cures, Shield of Faith, Bless, Prayer, Hold Person,
  Bull's Strength, Spiritual Weapon, Dispel Magic, Holy Smite, the revives…) at
  full-caster slot progression, **plus Channel Positive** (heals like a cleric of
  their level) and the ability to cast **Haste** and **Slow**.
- **Elfrip is a Flame oracle** — he also packs the Flame mystery's fire spells
  (**Burning Hands, Scorching Ray, Fireball, Fire Snake**) and *loves* to blast:
  his AI heals and buffs first, then hurls the widest fire it can, favoring
  Fireball and Fire Snake in a crowd. When one lands he gleefully shouts an
  excited **"BOOM!"**
- **Rhyarca** (Oracle of Besmara) and **Casandalee** are now oracles too.

### ♿ Blind-support overhaul — explore the table by keyboard
A big accessibility pass, shaped by a blind tester (Josh) playing live with a
screen reader.
- **Slower, adjustable narration.** The screen-reader voice now defaults to a
  gentler **1.2×** (was 1.7×, too fast for the cards), and you can fine-tune it
  live with **`[`** (slower) / **`]`** (faster) — persisted across reloads, no
  microphone needed.
- **Explore hotkeys** (table, blind mode on): **`C`** your cards · **`B`** the
  board (or "Preflop") · **`P`** the pot · **`M`** your cash · **`N`** your bet
  this hand · **`1`–`9`** a seat — says who's there, or, if empty, **arms it and
  says "Sit N"** so **Return** takes the seat (it stays armed through the table's
  re-renders, so a slow confirm still works).
- **`S` stops the talking instantly** — cancels the current readout, the queue,
  and any character-voice clip.
- **Diagnostics.** Blind mode logs its activity (capabilities, speech, the full
  speech-recognition lifecycle with error codes); allow-listed testers stream it
  to the server (`backend/logs/blind.jsonl`) so a remote, blind user never has to
  copy a console.

### 🗡️ Dungeon — escape hatches & no more double-booking
- **Two ways out, plus a kill-switch.** Delvers now have **↩ Leave dungeon**
  (bank your share, back to the felt) and **🛑 Cancel run** (force-end the whole
  run — everyone banks their share and returns upstairs; no gear lost), on top of
  the existing 👁 Spectate.
- **You can't be in two places at once.** The poker table no longer seats a bot
  who's currently delving, and **sitting down at poker pulls you out of any run**
  you were in — fixing a bug where a character showed up in the dungeon *and* at
  the table.
- **Clean wind-down.** When the last human leaves a run, the AI allies finish the
  current room and then leave, ending the dungeon on their own.

### 💰 Economy
- **Leaderboard ranks on CASH only.** Magic-item (gear) value no longer inflates
  your standing — only spendable gold (minus Abadar debt) counts.
- **No more cash cap.** Players and AI can hoard unlimited chips; winnings are
  never burned. The Loot Lord (+5 in every slot) is the only thing chasing wealth.

### 🔊 Voice
- **Storgrim** now speaks with the **Arnold2** voice.
- **Banter never names the wrong person.** A reused line that names someone (e.g.
  "facts, Tobias") is no longer replayed at a *different* person — the line-reuse
  pool now recognises real player names (humans included) and rerolls a fresh line
  when the addressee doesn't match.

---

## 2026-06-04 (per-class XP & AC types)

### 🎚️ Per-class XP + a permanent crown
- **XP is now tracked PER CLASS.** Switch class and you start fresh at *that* class's
  own level — a level-3 Wizard who swaps to Barbarian begins at Barbarian level 1, and
  swapping back restores the Wizard's level 3. **Gear is unchanged by the switch.** Each
  class keeps its own XP total in a per-character `class_xp` map.
- **The Loot Lord wears a permanent crown.** Whoever holds the most gold gets a 👑 over
  their token — and it now **persists forever**, surviving wipes and resets (no more
  ceremony / auto-reset). The crown follows the gold.
- **Full Wipe really wipes.** The "zero everyone to 5,000gp" reset now also clears
  **levels, all XP, equipment, and the Hall of Records** — a true fresh start.

### 🛡️ PF1 armor-class types (touch & flat-footed)
- The dungeon now tracks **normal AC, touch AC, and flat-footed AC** for every monster,
  the way Pathfinder does. The monster tile shows all three.
- **Spells and firearms resolve against touch AC** (a ranged touch attack ignores armor
  and shield), so a gun or a Scorching Ray connects far more often than a sword would.
- **Flat-footed** foes (caught before they act) lose their Dex to AC.

### 🪄 New caster spells & full-PF1 spell stat
- **Spells now assume an 18 casting stat**, just as attacks already assumed 18 Str/Dex
  — so save DCs and bonus spell slots follow the real PF1 math (DC = 10 + spell level +
  4), and casters gain **bonus 1st–4th level slots**.
- **Wizards & sorcerers cast Mage Armor** at the start of every fight (free action,
  run-long) — because **arcane casters wear no armor**: they gain only the *magic bonus*
  of any armor they own (a "+1 chain shirt" gives +1, not +4) and **never benefit from a
  shield**.
- **Protection from Evil** — a personal +2 AC / +2 saves ward.
- **Darkness** now blankets **1d4+1 foes** at once (was one), blinding them out of the
  fight; darkened enemies can't be targeted or attacked until it lifts.
- **Dispel Magic got smart targeting** — it auto-strips the **worst debuff on an ally**,
  or, if none, the **best buff on an enemy**.

### 🧠 Smarter, more PF1-correct combat
- **Melee can't hit flyers.** A melee weapon can no longer strike a flying creature —
  you need reach, a ranged option, or a spell.
- **Mind-affecting magic respects immunity.** Sleep, Fascinate, and Hold Person no
  longer work on **undead or constructs**.
- **AI heroes finish the room.** A bot that decides to leave now waits until the current
  fight resolves instead of bailing mid-swing.

### 🔊 Voice & pronunciation
- Fixed pronunciations: **Conchobar** ("con-cho-barr"), **Lirienne** ("leery-ehn"),
  **Rhyarca** ("ree-arka"), and **Rissa** ("riss-uh", short for Clarissa Caromarc).

---

## 2026-06-04 (leveling & inquisitor)

### 🎚️ Pathfinder XP leveling — the dungeon's biggest change yet
The dungeon abandons the old "your gear IS your level" system for real **Pathfinder
1e experience** (medium track). **Everyone resets to level 1** — gear is kept, but
now only adds to-hit / AC / damage; it no longer grants levels, HP, or feats.
- **Earn XP by fighting.** Each room awards the standard PF1 XP for the foes you
  vanquish (by CR), **split among the heroes still in the run** at room-clear — and
  being *downed* still earns your share. Humans and bots level the exact same way.
  (Pace is tunable via `XP_AWARD_MULT`, default 1.0 = true PF1.)
- **Level-ups are announced** with what you gained — BAB, HP, saves, new feats, and
  new spells / spell slots.
- **Death has teeth.** Die in the dungeon and you **lose a level**, dropping to the
  *start* of the previous level — so a hero who was about to advance can lose nearly
  two. (Get raised / Breath-of-Life'd before you actually die to avoid it.)
- **Wipe and you lose everything.** If the party is wiped — or flees an uncleared
  room with no one left to win it — **everyone loses ALL their gear**. If even one
  hero survives to clear the room, the party keeps its loot (they haul the fallen,
  and the loot, back upstairs).
- The party panel shows your **level and XP-to-next**; the room-clear line shows the
  XP earned.

### 🔨 The Inquisitor, reforged
- **A real spellbook.** The Inquisitor is now a **spontaneous divine caster** drawing
  a curated **cleric-list repertoire** (Cure Light/Moderate/Serious/Critical, Shield
  of Faith, Divine Favor, Hold Person, Bull's Strength, Spiritual Weapon, Dispel
  Magic, Prayer, Searing Light, Holy Smite) on the slower **6-level** progression —
  2nd-level spells from L4, 3rd from L7, 4th from L10.
- **Bane targets a creature TYPE.** Declaring Bane is now a **free action** (1 per 5
  levels per room): you pick a type present in the room (select a foe, then Bane) and
  the **+2 to-hit / +2d6+2 damage applies only to that type** until you re-declare.
  Every monster is now tagged with its PF1 creature type (undead, humanoid, animal,
  giant, magical beast, aberration, construct, ooze, outsider…).
- **Bonus feats.** The Inquisitor earns the fighter feat ladder at **half rate** — a
  feat every odd level (Weapon Focus, Dodge, Toughness, Weapon Specialization,
  Improved Initiative, Iron Will, Improved Critical, Critical Focus).
- Judgements are unchanged — free to switch, and they last the whole room.

### ⚜️ Paladin — Smite & Detect Evil
- **Smite Evil is now a free action** — declare it without spending your turn. It
  still strikes only **evil-aligned** foes (alignment is tracked for every monster),
  for +to-hit and +double-level damage, once per 5 levels per room.
- **New: Detect Evil** (a standard action) **marks every foe in the room as evil**,
  so your Smite lands on all of them — even true-neutral animals and constructs.
  Marked foes show a bullseye icon, and it plays an "into the light" cue.

### 🔁 Voice lines get cheaper to repeat
- **A line-reuse pool** (`util/linePool.js`). Now that ElevenLabs **v3** voices sound
  great (but cost more), characters **replay a past voiced line** instead of paying
  for a fresh LLM + 11labs call when it fits: ~**70%** of the time on a perfect match
  (a generic line for that moment, or a dungeon bark against the same foe), and only
  ~**10%** when the line might not fit (it names someone, carries an amount, or it's a
  different enemy) — so it mostly generates fresh when unsure. Saved clips are
  **tagged with their model version** (v2/v3). The pool fills as bots talk, so the
  savings grow over a session. Tunable via `LINE_REUSE_PROB_MATCH` /
  `LINE_REUSE_PROB_LOOSE` / `LINE_POOL_MIN` / `LINE_POOL_MAX`.

### 🩹 Follow-ups
- **Banter is now one sentence.** Lines were capped by *word* count, not *sentence*
  count, so a punchy multi-exclamation style (Farrus, bellowing) could slip through
  as 2–3 sentences — tripling the voice time + 11labs cost. Every banter line is now
  clipped to a single sentence (with a min-word floor so a tiny "Ha!" keeps its
  follow-up, and an honorific guard so "Mr. Brow" isn't split), at the table and in
  the dungeon. The line-reuse pool was cleared so older multi-sentence clips don't
  replay.
- **Inquisitor gains Bless** — the run-long party **+1 to hit** (cast once, lasts the
  whole dungeon), rounding out his cleric-list repertoire.

---

## 2026-06-03

### ⚔️ Classes, feats & enemy casters
- **Swashbucklers** join the roster (Concetta & Holden, rapier in hand) — finesse
  duelists who **Parry** the first attack on them each round (success = no damage
  + a free **riposte**), **Disarm** a foe to cost it a turn, and pile on **Precise
  Strike** (+level damage), Weapon Focus/Specialization and **Improved Critical**
  with a finesse blade. They take **no AC from a shield** — they fight a hand free.
- **Fighters earn PF1 bonus feats as they level** — Weapon Focus, Dodge,
  Toughness, Weapon Specialization, Improved Initiative, the save feats, **Improved
  Critical (8)**, **Critical Focus (9)** and **Improved Cleave (11)** — plus a
  **Power Attack** free on/off toggle (flip it without spending your turn).
- **The Magus** channels four **Spell Strikes** — SS Shock, SS Frigid, SS Max SG
  (Intensified Shocking Grasp), and SS Vamp (**Vampiric Touch**, which heals you).
- **Liches now fight as full wizards of their level** — Hold Monster, Fireball /
  Cone of Cold / Chain Lightning, Disintegrate, Finger of Death and Magic Missile,
  with smart target-picking and DCs/damage that scale with depth. **Vampires**
  drain life with a magus **Vampiric Touch**. Liches are cold-immune (undead).
- **Clerics learn Spiritual Weapon** — conjure a force-blade over a foe and it
  **attacks that foe on every one of your turns** (with your buffs, feats & Haste,
  re-targeting if it dies) for **1 round per 2 caster levels** — so the cleric can
  cast and heal while it fights on.
- **Sorcerers learn Haste**, and **Stoneskin** is now cast on whoever has the
  **least HP**.

### 🃏 Poker & UI
- **Preflop is snappier** — bots decide their opening hands **50% quicker**.
- **Fixed bots folding preflop** — they no longer **bluff-raise into a full
  table**, so far more hands actually reach a flop. (Post-flop bluffing unchanged.)
- **The dungeon spellbook is now a fixed, always-on-screen panel** with its own
  scrollbar — no more zooming the browser out to reach your higher-level spells.
- **Ranged heroes use their real weapon sounds** — Duristan's bolt-action Lapua
  cracks like a rifle instead of twanging like a bow (and crossbows sound like
  crossbows).
- **Fixed the double scrollbar** in the dungeon hero-select (recruit) popover.

## 2026-06-03 (latest+)

### 🎭 Caster polish, buff icons & class smarts
- **Inspire Courage scales** with the bard's level (PF1-style): **+1**, rising to
  **+2 / +3 / +4** at levels **5 / 11 / 17**.
- **Bards** learn **Dispel Magic** (3rd-level) and now play the controller: once
  the party buffs are up they **pin a boss with Hideous Laughter** (Held — it
  survives being hit, so the team keeps focus-firing while the boss wastes turns).
- **Wizards & sorcerers** gain two **4th-level** spells: **Fire Snake** (a flaming
  serpent — 1d6/level fire, up to 4 foes, Reflex half) and **Stoneskin** (**DR 10
  vs physical blows** on a front-liner — energy and spells punch through).
- **Barbarians** now swing at the **lowest-HP foe first**, fishing for the kill
  that carries a **Cleave** chain into the pack.
- **Every buff shows its own icon** on a hero's buff strip — Bull's Strength,
  Cat's Grace, Bear's Endurance, Heroism, Good Hope, Shield of Faith, Deadly Aim,
  and Stoneskin all joined the lineup (they were applying invisibly before). The
  **Rage** badge is now Bobby B's glowing-eyed war face.
- **Fascinate** gets its own **"Fascinated"** debuff icon (no longer mislabeled
  "Asleep"), and casters **won't waste Sleep or Fascinate** on a foe already
  asleep/fascinated — the cast is refused (slot kept) and group versions skip
  anyone already entranced. Non-rogues leave the entranced alone; rogues pounce.

## 2026-06-03 (latest)

### 🪄 The spellcaster overhaul
- **Spell slots, the PF1e way.** Spontaneous casters (**sorcerer, bard, oracle**)
  get **per-level spell slots** by their PF1 progression; **clerics** prepare from
  a real per-level list; prepared **wizards/druids** cast each known spell once a
  room. Slots refresh every room. The **spellbook** shows how many slots of each
  level you have left, and **bard class features** (Inspire, Fascinate) now sit
  **beside** the spellbook instead of inside it.
- **Cleric spell list** filled out by level — Cure Light/Moderate/Serious/Critical,
  **Shield of Faith**, Divine Favor, **Bless** (once a run), Hold Person,
  Bull's/Bear's, **Prayer**, Searing Light, Dispel, **Protection from Fire**
  (auto-cast when fire foes appear), and **Blessing of Fervor** (acts like Haste).
- **Shield of Faith** now lands on the **ally with the lowest AC** — the one who
  needs the +2 deflection most.
- **Prayer** sweeps the **whole battlefield**: allies **+1** to hit/damage/saves,
  enemies **−1**, for the rest of the room.
- **Sorcerers & wizards** gain **Shield** (self-only **+4 AC** for the room) and
  **Fly** (immune to non-ranged attacks, high-ground bonuses); sorcerers also pick
  up Sleep, Cat's Grace, and Dispel Magic at the right levels.
- **Acid Arrow keeps burning** — it deals acid **again each of the target's turns**
  for **1 round per 3 caster levels**, not just on the hit.

### 🖥️ Battlefield fit
- The enemy field is now a **fixed-height box**: when a room gets crowded the
  **cards shrink to fit** instead of pushing the action bar and **spellbook** off
  the bottom of the screen — so you can always scroll to your higher-level spells.

## 2026-06-03 (late night)

### 😈 The Barbed Devil, a sniper & reference pages
- **The Barbed Devil** is now a real terror — in **Slorr's voice**. It hurls a
  **barbed chain hook** at your **weakest** hero, **grappling** them and
  **crushing** them every turn (−2 to hit, easier to strike). **Dispel Magic or
  Grease breaks the grapple.** It also looses a **Hellfire Blast** (fire AoE).
- **Taelys** trades up to the **DVL-10 bolt-action sniper rifle** (2d8, ×4). A
  bolt-action **can't Rapid Shot**, so she leans on **Bullseye Shot** and the new
  **Deadly Aim** feat — trade accuracy for big damage. (Deadly Aim is open to all
  rangers; bow rangers keep Rapid Shot.)
- **Reference pages** for **Monsters / Spells / Classes** (a live, compact view
  of everything loaded) are reachable from the **🔊 settings menu**, each with a
  **Back to table** button.

## 2026-06-03 (night)

### 🪚 Chainsaws, real Rage, bard spells & smarter buffs
- **Tokala wields a Chainsaw** — a roaring **3d6 slashing** two-hander that
  **crits on an 18**, with its own snarling sound.
- **Barbarian Rage** now scales like PF1e (Greater at 11, Mighty at 20) and
  pumps **Constitution → temporary HP** (e.g. **+20 HP at level 10**), on top of
  the to-hit / damage / Will bonuses and −2 AC. The temp HP fades between rooms.
- **Bards** learn **Cure Light Wounds** (1st) and **Cure Moderate Wounds** (2nd),
  plus the 2nd-level buffs **Bull's Strength**, **Cat's Grace**, and **Bear's
  Endurance** — single-ally, last the room — and now get a proper **spellbook**.
- **Barbarians** are limited to **medium armor** (a breastplate), not full plate.
- **AI casters** no longer waste a turn re-casting a non-stacking buff (Inspire,
  Haste, Shield…) that's already up on the party.
- The **Goblin Barbarian's taunt** now compels **everyone** — even your own
  attack gets dragged onto him.

## 2026-06-03 (evening)

### ⚔️ Dungeon combat depth
- **Great Cleave** — every foe you drop with a Cleave grants another swing,
  chaining until you stop felling them. A clean sweep can clear a whole pack.
- **Barbarian Taunt** (once/room) — a roaring challenge; every enemy Will-saves
  or is forced to attack the barbarian next turn, pulling fire off the squishies.
- **Disintegrate** now works the PF1e way: a **ranged touch attack** (it can
  miss), **2d6 per caster level** (up to 40d6), **Fort partial = only 5d6**, and
  anything dropped to 0 HP **crumbles to dust**.
- **Fire Skeletons** are suicide bombers — they rush in and **detonate on their
  turn** (1d6 fire/level to 1d2 heroes), destroying themselves. **Kill them first
  to defuse.**
- **AoE spells** roll their damage **once** for the whole burst; each target
  saves against that number — full / half / **none with Evasion** (rogues &
  monks). Already-crowd-controlled foes are skipped by AoE/CC targeting.
- **Flying creatures** (harpy, gargoyle, chimera) are **immune to prone** and
  hold the **high ground** (+1 to hit, +2 AC vs grounded heroes).

### 🎭 Vorkstag, dungeon access & UI
- **Vorkstag** the skinwalker now **changes whose face he wears mid-game** —
  rarely each poker hand / dungeon room, more often (25%) when he's addressed.
- Dungeon **spectators can Join** the fight; delvers can **Spectate** (bank gold,
  keep watching) without returning to the table.
- **"My Loot Bank"** is reachable from the dungeon, not just the poker table.
- **Channel Positive** now heals the **whole party including the downed/dying** —
  it can pull a dying ally back to their feet.
- **Inspire Courage** is a **passive aura** — always up while a bard is present,
  no action spent.
- **Monster debuffs** show name + effect on hover, like heroes'.

### 🧮 Economy, art, voices & deploys
- **Loans** tick **once per poker hand** and **once per dungeon run** (not per
  action / room / turn) — you only accrue interest while actually playing.
- **Leaderboard & Hall of Records** get a **Hu / All** toggle (default Humans),
  remembered across sessions.
- Real token art for the **Lich, Vampire, Fire Skeleton, Blood Caimon**.
- **Kai Ginn & Kelda** now talk like zoomers (Graham characters).
- **Patch notes** post in full to table chat (multi-line, no more cut-offs).

## 2026-06-03 (later)

### 🐌 Slow, real Hold Person, elemental resistances & more
- **New spell — Slow** (Wizard/Sorcerer/Bard, 3rd level): a random **2d4** foes
  Will-save or are slowed (act only every other turn, −1 AC). Cast to the
  **Evil Morty theme**.
- **Hold Person** now works the PF1e way: the victim is **Held for multiple
  rounds**, and each of its turns it may attempt a **new Will save to break
  free — but the attempt eats its turn either way**. Much nastier. (Hideous
  Laughter uses the same rule.)
- **Energy resistances & vulnerabilities** on monsters: **Fire Skeletons are
  immune to fire** but take **×1.5 from cold**; **Wood Golems** take ×1.5 from
  fire; most **undead are immune to cold**; vampires resist cold & lightning.
  The log shows ⛔immune / 🔥×1.5! tags.
- **Spellbook** now organises by true **PF1e spell level** (Cone of Cold is 5th,
  not 9th), opens **down-and-right anchored to the button** (no longer over the
  chat box), and shows icons-only with name/desc on hover.
- **Blood Caimon** gets real gator art instead of 🐊.
- **Leaderboard & Hall of Records** each get a **Hu / All** toggle, default to
  **Humans-only**, and remember your choice.

### 🧛 Undead monster art + smarter arcane casters
- The **Lich**, **Vampire** and **Fire Skeleton** now show real Foundry token
  art (a skeletal lich in his mitre, a fanged vampire lord, a burning skull)
  instead of plain 💀🧛🔥 emoji.
- **Wizards & sorcerers** now fight like battlefield controllers: by default
  they cast whatever **affects the most enemies** (a wide Fireball / Lightning
  Bolt / Burning Hands, or mass lockdown via Sleep / Grease). When a lone
  **boss** towers over the pack, they focus-fire it with their hardest single
  spell (**Disintegrate** / Cone of Cold) or pin it with **Hold Person**.
- **Channel Positive** now rolls its healing **once** and applies that amount to
  the whole party (PF1e-correct), instead of re-rolling for each ally.

### 📜 Readable, colour-coded dungeon combat log
- The combat log is now **split horizontally** — your **heroes' actions sit on
  the left**, the **monsters' on the right** (run/loot/chat events run down the
  centre). Each side is easier to follow when the action moves fast.
- **Subtle colour cues** so you can skim: healing is **gold**, deaths are
  **red**, buffs are **blue**, debuffs are **purple**.

### 🗡️ Vorkstag is a Rogue
- Vorkstag now delves as a **Rogue** (shortsword + Sneak Attack) instead of an
  alchemist — and benefits from the rogue AI that hunts helpless targets.

---

## 2026-06-02

### 🎶 Bard Haste & laughter-into-sneak synergy
- **Bards** can now cast **Haste** (a 3rd-level spell) — and the AI loves to buff
  the party up with it (bots cast Haste after their other buffs).
- **Hideous Laughter** leaves a foe **helpless** (paralyzed), which makes it open
  to **Sneak Attack** — and rogues now hunt those laughing targets.
- Fixed: a hasted caster's free bonus swing no longer **drowns out the spell
  they cast** (the bonus attack is silent so the spell's sound is what you hear).

### 💨 Haste duration & a smarter dungeon timer
- **Haste** now lasts **1 turn per 5 caster levels** (rounded down) — each hasted
  turn grants an extra attack, instead of just one.
- The dungeon **turn timer** is extended to **30 seconds**, and when it runs out
  you now **auto-attack** the best target instead of just passing the turn.

### 🧹 Status polish & quality-of-life
- Dungeon **buffs** now sit **top-left** of a hero card (debuffs top-right), and
  **hovering any status icon** shows its **name + a short summary** of what it does.
- Cut-off sound effects bumped from a **4s to a 5s** cutoff.
- **Besmara** is now pronounced correctly in voice ("bez-marra").
- Kicking an **AI** mid-hand now lets it **play the hand out** (it leaves after,
  instead of being force-folded).

### 🏛️ Loan from Abadar — keep your gear
- You no longer have to **hock your magic items first** to take a Loan from
  Abadar (just like the AI). Borrow a fresh stack **on top of** what you're
  holding — it's a real loan added to your debt, not a chip reset, and you keep
  every piece of gear. (The debt still compounds while you owe it.)

### 🗡️ Rogues hunt the helpless
- Rogues now **prefer incapacitated foes** (flat-footed, prone, sickened, held,
  or **asleep**) so they land **Sneak Attack** — they'll gladly stab a sleeping
  enemy, while everyone else still avoids waking it. A rogue only **Feints** when
  there's no opening to exploit. (Asleep/fascinated now counts as denied-Dex for
  Sneak Attack.)
- **Dispel Magic** clears a debuff off an afflicted ally (and is ready to strip
  enemy buffs once foes can carry them).

### ✅ Buffs show on heroes
- Heroes now display their **active buffs** as a green-ringed icon strip on the
  token (debuffs stay red up top): **Rage, Shield, Divine Favor, Bane, Prayer,
  Bless, Inspire Courage, Smite, Haste, Invisibility**, and the three Inquisitor
  **Judgements**. Hover any icon for its name. Art sourced from the Foundry icon
  library.

### 🎲 Sound variety, Druids, Dispel & spookier undead
- **Fireball** and **Lightning Bolt** now **alternate between several sound
  variants** each cast (no more identical boom on repeat); Haste does too.
- **Druids** join the fray — **Entangle** (roots a random 1d4 foes), **Cure Light
  Wounds**, and **Call Lightning**.
- **Dispel Magic** (clears a debuff off an ally) and **Acid Arrow** added to the
  arcane lists.
- **Barbarian Rage** is now a **free action** — rage AND still attack the same
  turn (and it roars like Odin).
- **Rogues** get a signature sneak-attack sound with light blades; a slain hero
  gets a somber death cue.
- New foes: **Lich** and **Vampire**, whose **sinister gaze** can freeze a hero in
  terror (Will save or lose a turn). Minotaurs now bellow.

### 🪄 Even more spells, an Inquisitor judgement system & ~19 sounds
- **Wizards** learn **Invisibility** (can't be targeted until you attack),
  **Cone of Cold** (2+1d3 foes), and **Disintegrate**; **sorcerers** get Cone of
  Cold + Disintegrate too.
- **Clerics & Inquisitors** gain **Searing Light**. **Magi** get **Frigid Touch**
  (a freezing spellstrike that staggers). **Bards** get **Hideous Laughter**, and
  their **Inspire Courage** now buffs the whole party for the **entire dungeon**.
- **Inquisitor JUDGEMENTS** — a free-action toggle (switch any time, no action
  cost): **Destruction** (+damage), **Protection** (+AC), or **Healing** (regen
  each turn). Only one active at a time.
- **Fire Skeletons** — explode on death, scorching 1d2 nearby heroes.
- **Danger's longbow** is now near-silent (the sound lands on the hit); warhammers
  ring (and ring *holy* on a paladin's smite); Dismas's Rovadra fires faster.
- ~19 new sound effects across all of the above.

### ✨ New spells, foes & a pile of sound FX
- **Clerics** gain high-level prayers as they level (PF1e progression):
  **Boneshatter** (lvl 5), **Breath of Life** (lvl 7, revives a dying ally),
  **Raise Dead** (lvl 9) and **Resurrection** (lvl 13, slain ally back at full HP).
- **Scorching Ray** now SPLITS — **2 rays at caster level 7, 3 at 11**, each
  rolling to hit (with a meatier "fire-combo" sound when it splits).
- **Wizards** learn **Haste** — the whole party blurs and gets an **extra attack**
  on their next turn. **Sorcerers** learn **Gust of Wind** — knocks down a random
  1d3 foes (Fort save or prone).
- **Skeletal Champions** now loose a **bone-rattling shout** — 1d8 + Fort save or
  **stunned** (shown with the PF1 stunned icon).
- **Farrus Richton** now dual-wields **twin battleaxes** — two strikes a turn (one
  axe-chop sound), and no shield.
- New foes: the **Blood Caimon** (giant red alligator) and the **Badger**.
- A dozen new sound effects across channels, revives, shouts, bites, gusts, blunt
  weapons and more.

### ✝️ Clerics reworked — full prayer book
- Clerics are now **prepared divine casters** (like wizards): **one casting of
  each prayer per room**. Their book: **Cure Light / Cure Moderate Wounds**,
  **Divine Favor** (+3 hit & damage to self, the room), **Holy Smite**,
  **Prayer** (+1 hit & damage to *all allies*, the room), **Bless**, and
  **Channel Positive**.
- **Bless** is special: cast **once for the entire dungeon**, it gives every ally
  **+1 to hit that never fades between rooms**.
- **Channel Positive** uses Pathfinder norms — heals **½ caster level d6** to the
  whole party, usable **once per 5 levels per room**.
- Upshot: Holy Smite is now a single prepared cast per room (no more spam), and
  the cleric plays like a real support — buff, heal, smite, then wade in.

### ⏱️ Auto-skip countdown in the dungeon
- On your turn in the dungeon, a **live countdown** now shows just to the right of
  your token, so you can see exactly how long before you auto-skip.

### 🖼️ Missing avatars fixed
- The PNG→WebP conversion had orphaned some token paths, so a few avatars stopped
  showing. Repaired the token manifests and migrated any stored avatar that still
  pointed at a deleted `.png` over to its `.webp` — broken portraits are back.

### 🎭 AI allies vary their abilities (no more spam)
- Dungeon bots no longer repeat the same ability every turn — they won't use the
  same one twice in a row when they have another option. So the cleric alternates
  **Holy Smite / Hold Person** instead of hammering Holy Smite (and its sound)
  over and over; martials mix Trip/Cleave, Rapid Shot/Bullseye, etc.

### 🪓 Ulfred's battleaxe "Voidshard"
- Ulfred now swings a named battleaxe, **Voidshard** (1d8, ×3), with its own
  meaty axe report.

### 🚪 Leave button always visible
- The **Leave** button moved out of the ≡ menu to the top-right, so it's always
  one tap away (no more digging through the mobile hamburger to stand up).

### 🧠 AI allies use their class abilities
- Dungeon bots no longer just swing every turn — they now **play their kit**:
  **paladins** Smite and **Channel-heal** a wounded party, **clerics** heal /
  Holy Smite / Hold Person, **wizards & sorcerers** sling spells (blasting groups
  with AoE, picking off the weak with single-target), **magi** raise Shield then
  Spell Strike, **barbarians** Rage then Cleave, **bards** Inspire then Fascinate,
  **rangers** Rapid Shot, and so on. They heal when someone drops below ~55%,
  buff once at the top of a fight, and fall back to a basic attack when nothing
  better fits.

### 🩹 Debuff icons in the dungeon
- Heroes and monsters now show their active debuffs as proper **PF1 condition
  icons** — **Sickened**, **Paralyzed**, **Asleep**, and **Prone** — right on
  their cards (hover for the name), instead of stray emoji.
- Fixed: **Hold Person** now actually freezes an *enemy's* turn (a paralyzed
  monster loses its turn, as it should).

### 🗣️ Elfrip grows up a little
- Elfrip speaks a touch more grown-up now — fuller sentences, fewer dropped
  words — while still talking about himself in the third person ("Elfrip wins!").

### 🏛️ Abadar charges interest
- Your **tab with Abadar now compounds**: **+5% for every 10 turns** you play —
  poker actions *and* dungeon combat turns both count — for as long as you owe.
  A chat line marks each time it grows. **Pay it down** to stop the clock (it
  resets the moment you're square). Bots never owe.

### 🖼️ Art converted to WebP (faster loads)
- Every PNG asset (card back, character art, monster + token art) is now **WebP**
  — the same images at a fraction of the size (~9 MB → ~1 MB), so the table and
  dungeon load quicker.

### ⚔️ Magus reworked — Spell Strike & Shield
- A magus now makes a **basic attack with their chosen weapon**, plus two powers:
  **Spell Strike** (that attack **plus up to +5d6 electricity** — Shocking Grasp
  through the blade, usable **once per room per 5 levels**) and **Shield** (a
  **+4 AC** ward that lasts the rest of the room).
- Signature Spell Strike sounds per magus: **Kate**, **Vaughan**, and **Toni**
  each get their own.

### 🪄 Wizard vs. Sorcerer — two kinds of caster
- **Wizards** are prepared casters: **one casting of each spell they know, per
  room** (so their volume grows as they unlock more spells — no more spamming a
  single Fireball).
- **Sorcerers** know **fewer** spells but cast from a **shared per-room pool**
  (their limited casts/day), free to recast their favorites until it runs dry.
- **Farrah** is now a sorcerer.

### 🔊 Audio leveled out + new sound FX
- **Every sound is volume-normalized** so nothing blares over the rest (the
  repeating crossbow was the worst offender).
- New/changed cues: **Scorching Ray** now intones a **Dragon Slave**; **Sleep**
  gets a quick *shh*; **Dismas's** Rovadra cracks with an echoing delay;
  **Taelys's** rifle is now a **silenced DVL** shot; the monk's kiai pool is
  trimmed to short, snappy clips. (And nobody hiccups "hic" out loud anymore.)

### 🐢 Dungeon pacing & smarter allies
- A **~1-second beat between turns** so the action is easier to follow.
- **AI allies avoid hitting sleeping/fascinated foes** — they won't wake your
  crowd-controlled enemies for free.

### 🏛️ "Loan from Abadar"
- The **Re-buy** button is now **Loan from Abadar** — same fresh stack, same loan
  added to your debt, just by its proper name.

### 🎒 Loot bank & Hall of Records polish
- The **My Loot Bank** popover now shows a **paper-doll** of your equipped gear
  over a **Vitruvian Gaspar** backdrop.
- **Hall of Records** gains **Human / AI filters** (and fits on one row).

### 🔥 Fireball goes wide
- **Fireball** now engulfs a **random 1d6 enemies** (was a fixed 3) — great
  against the new goblin hordes, but you never quite know how many it'll catch.

### 👺 Goblin hordes with teeth
- Rooms now favor **swarms of cheap mooks** — a full party gets buried under
  goblins, kobolds, centipedes and the like (10–14 of them) instead of a few big
  bruisers.
- New **Goblin Rogue** and **Goblin Shaman**, and enemy **Sneak Attack**: a
  shaman's **Hold Person** locks a hero down, then the rogues pile on for **+2d6**
  against held or flat-footed targets. (Kobold Rogues sneak too now.)

### 🗡️ Dungeon scales with party size (more heroes = more enemies)
- Rooms now throw **a lot more monsters** at a packed party — each hero past the
  first adds roughly a full encounter's worth of foes (a level-3 party meets ~2
  enemies solo, ~7 at four heroes, ~10 at six). Each foe's CR still tracks the
  weakest member (so nobody gets one-shot), but you'll get swarmed. **Boss rooms
  now bring minions** too, scaled to party size.

### ⚖️ Inquisitor — Bane & Divine Favor
- The inquisitor's abilities are now **Bane** (+2 to hit and **+2d6+2** damage
  vs their foes) and **Divine Favor** (+3 to hit and +3 damage to themselves),
  each lasting the rest of the room. Sticky buffs no longer stack with themselves
  on a re-cast (and Rage / Inspire are protected the same way).

### ⚔️ Rogue/inquisitor martial proficiency + named sniper rifles
- **Rogues and inquisitors are now proficient with all martial weapons** (exotics
  like the whip/katana still take the −4 without the feat).
- The rangers' sniper rifles are now distinct, named guns with their own Tarkov
  reports: **Duristan** wields a **Lapua .338** (2d10, ×4) and **Taelys** an
  **SV-98** (2d8, ×4).

### ⚔️ Every NPC now has a class & signature weapon
- Filled in the last of the unclassed NPCs: **Agu** (inquisitor, rapier),
  **Chef** (rogue, battle axe), **Crisp** (rogue, Bite 1d6), **Kai Ginn** (ranger,
  glaive), **Lirienne** (ranger, repeating crossbow), **Rissa** (druid, Claws),
  **Taelys** & **Duristan** (rangers, sniper rifle 2d8), **Ulfred** (cleric,
  warhammer + shield), **Vaughan** (magus, scimitar "Radiance"), **Texas Holden**
  (swashbuckler, rapier). New repeating-crossbow & sniper-rifle sounds.
- NPCs are now **always proficient with their assigned weapon** (the −4
  non-proficiency penalty only ever applies to a human's own weapon choice).

### ⚔️ More NPC classes (and a Bujon fix)
- **Vesorianna** — cleric, wields a spectral **Ghost Touch** (2d6).
- **Farrus Richton** — barbarian with a greataxe.
- **Dinvaya** — cleric (warhammer + shield).
- **Storgrim Thunderbeard** — fighter (battle axe + shield).
- Fixed **Bujon** silently defaulting to Fighter — he's a **sorcerer** as intended
  (his name/nickname key didn't match).

### 📜 Hall of Records — filter by Humans / AI
- The Hall of Records now tracks every category for **humans and AI separately**.
  New **All · 🧑 Humans · 🤖 AI** filter buttons let you see the best across
  everyone, the best human, or the best AI for each record (Gain, Loss, Pot, War,
  Bluff, Ugliest).

### 🎒 Loot Bank is a paper doll now
- "🎒 My Loot Bank" is just a button — click it and a **paper doll** pops up with
  your character, every equipped gear slot (weapon/armor/shield/cloak/ring), and
  buy/hock buttons right there. Click anywhere outside (or ✕ / Escape) to close it.

### 🗺️ Dungeon starts at the weakest delver's level
- A run's first rooms now start at the **CR of the lowest-level party member**
  (so nobody gets one-shot in room 1), then ramp up as you descend — instead of
  averaging the party.

### 🏦 Bots borrow instead of pawning their gear
- When an AI busts, it now **borrows from the First Bank of Abadar** (a loan,
  keeping its magic items) instead of "hocking" them — the chat flavor and the
  ledger both reflect a real loan now. Only when a bot is **drowning in debt**
  does it pawn its cheapest item (named) as a last resort to stay seated.

### ⚖️ Encounters scale to your party (PF1 CR rules)
- Now that heroes are much tougher (class HP, abilities, real to-hit), rooms are
  built to match. Each room targets an **encounter CR based on your party's
  Average Party Level** — ramping up as you descend, eased for small parties,
  and stepped up on boss rooms — then filled with monsters by **PF1 XP budget**
  (so "two CR-3s = a CR-5 room" math is exact). The Brass Golem / Barbed Devil
  bosses now appear only when a deep, high-level party can actually face them.

### 🔧 Stale-client fix
- Fixed the "I still see the old buttons / no spellbook" bug: the HTML shell is
  now served **no-store** for the root and all routes, so a plain reload always
  loads the latest UI. (One more hard refresh, then you're set for good.)

### 🏹 Danger the ranger + 🧙 caster Elemental Ray
- **Danger (Rodney "Danger" Smith)** is now a **ranger** with a **Composite Longbow**
  (1d8, ×3). He has **Point Blank Shot** (+1 to hit & damage with the bow) and can
  use **Attack** (one shot), **Rapid Shot** (2 shots at −2), or **Bullseye Shot**
  (1 shot at +4) — with real single-shot and multi-shot bow sounds.
- **Elfrip** is now a **fire sorcerer** — Scorching Ray at level 4, **Fireball** (his
  favorite) at level 7.
- **Wizards & sorcerers no longer swing a weapon** — their basic attack is an
  **Elemental Ray** (a ranged touch for **1d6+4 cold**, the *Avatar* ice-punch
  sound). It's unlimited, and it's also their **poker-table harassment** attack
  (they fire a frost ray instead of flailing a dagger).

### 🔮 Sorcerer Magic Missile + Barbarian rework
- **Sorcerers** now open (level 1) with **Magic Missile** and **Sleep** alongside
  Burning Hands and Shocking Grasp. Magic Missile fires the proper PF1 count —
  **1 dart, +1 every 2 levels (max 5)**, each an unerring 1d4+1 — and rips off the
  *Aliens* pulse-rifle **burst** sound. Extra darts spread across your selected foes.
- **Spell pools follow PF1**: your per-room casts are a sorcerer's 1st-level spell
  slots + the bonus slot for an 18 casting stat (4 at level 1, up to 7).
- **Barbarian** is now **Attack · Cleave · Rage**: Cleave hits two foes but drops
  your guard (−2 AC that turn); **Rage** lasts the room for **+2 to hit & damage,
  +1 Will, but −2 AC** (and yes, it stacks with a reckless cleave).

### 💤 Wizard gets Sleep
- A level-1 **Wizard** now opens with **Shocking Grasp, Grease, and Sleep**.
  **Sleep** drops up to 3 of the weakest foes (Will save) into a helpless slumber
  — they lose their turns until something hits them.

### ❤️ Class HP + 📖 a real spellbook menu
- **Hit points are now set by your class's Hit Die** (max roll per level): a
  level-6 Barbarian has 72 HP, a Fighter/Paladin 60, a Cleric/Rogue/Bard/Magus
  48, a Wizard/Sorcerer 36. Casters are squishier — position accordingly.
- **Spellcasters get an expandable 📖 Spellbook ▾ menu** instead of a wall of
  buttons — it lists every spell with its **art icon**, target count, level
  requirement, and the shared cast-pool remaining. Each spell now shows a proper
  **PF1 icon** (fireball, lightning bolt, scorching ray, hold person, channel, …);
  martial maneuvers keep their glyphs.

### 📖 Spellbook v2 — level-gated spells, signature weapons, sharper martials
- **Casters now have a real, level-gated spell list** that draws from a shared
  **per-room cast pool** (bigger at higher level):
  - **Wizard** — Burning Hands, Shocking Grasp, **Grease** (2 foes slip prone, *splat*);
    at L3 Scorching Ray + Hold Person; at L5 Fireball + Lightning Bolt.
  - **Sorcerer** — Burning Hands, Shocking Grasp; Scorching Ray (4d6) at L4;
    Lightning Bolt + Fireball at L7.
  - **Cleric** — Hold Person · Holy Smite (2 foes) · Channel Positive (party heal).
- **Martials sharpened:**
  - **Fighter Trip** is now an attack roll that deals no damage — on a hit the foe
    is knocked **prone, loses its turn**, and you get a **free attack** (prone = +4
    for everyone to hit it).
  - **Rogue** Sneak-Attacks anything **prone / flat-footed / sickened / paralyzed**,
    strikes **twice with daggers**, and **Feint** is an opposed roll that sets up a
    free Sneak-Attack strike.
  - **Paladin Smite** now adds **double your level** to damage (1/room per 5 levels),
    and Lay on Hands became **Channel Positive** (party heal).
- **Bard** (Elodie) — **Inspire Courage** (party +to-hit/+dmg for the room) and
  **Fascinate** (up to 3 foes lose their turns *until something hits them*).
- **Signature weapons:** **Dismas** wields the holy dragon-rifle **Rovadra** (1d12,
  with its own shot sound — and yes, he smites with it); **Gaspar** carries the
  bastard sword **Curator**. Named weapons are always wielded proficiently.
- **Proficiency:** **Fighters, Rangers, and Paladins are now proficient with every
  weapon, even exotics.**

### 📖 Class abilities & a PF1 spellbook (dungeon)
- **Every class now fights its own way.** You get an **at-will attack every turn**
  plus **two class abilities**, mapped as close to Pathfinder 1e as our combat
  allows. Martial abilities are **condition-gated** (use them whenever it's smart);
  spells and channels are a **per-room pool that grows with your level**.
- The **core 10** classes are live (the rest stay in the data but are hidden from
  the dropdown for now):
  - **Fighter** — Trip (→ prone + free hit) · Cleave (hit two foes)
  - **Barbarian** — Rage (+to-hit/+dmg this room) · Reckless Blow (+dmg, drop guard)
  - **Rogue** — Feint (→ Sneak Attack) · Dirty Trick (blind a foe)
  - **Paladin** — Smite Evil · Lay on Hands (heal)
  - **Cleric** — Channel Energy (heal party) · Hold Person
  - **Wizard** — Ray of Frost (cantrip) · Fireball · Magic Missile
  - **Sorcerer** — Ray of Frost · Lightning Bolt · Scorching Ray
  - **Magus** — Shocking Grasp · Frigid Touch (spellstrikes)
  - **Inquisitor** — Judgment · Bane (weapon buffs)
  - **Bard** — Inspire Courage (party buff) · Hideous Laughter
- The dungeon action bar shows your kit (with **remaining uses** on spells), and
  each spell has its own **sound** drawn from the studio library. Keys: **A** =
  attack, **Q/W** = your two abilities, **1–9** = target. Blind mode speaks your
  kit and takes the ability names as voice commands.

### 👁 Spectate the dungeon
- A new **👁 Spectate the Dungeon** button in your 💰 money menu lets you watch
  the current run **without leaving your seat or joining the fight** — and
  **heckle the delvers in chat** (your jabs show up tagged "(watching)"). Call a
  bot ally out by name and they'll still fire back. Hit **↩ Back to the table**
  to return whenever you like.

### 💬 Chat in the dungeon
- The dungeon now has a **chat box**, just like the poker table. Type to your
  party and your line drops into the shared run log for everyone delving with
  you. If you call a bot ally **by name**, they'll bark back in character (with
  voice, when AI voices are on).

### ⚔️ Weapon proficiency by class
- Your class now determines which weapons you're **trained** with. A wizard
  swinging a greatsword takes the PF1e **−4 non-proficiency penalty** to hit;
  a fighter wields it cleanly. Full casters are restricted to their handful of
  weapons (the wizard's dagger & quarterstaff), martial classes get everything,
  and signature picks are honored (a rogue's short sword, a samurai's katana, a
  cleric's warhammer, a druid's scimitar).
- **The weapon dropdown now sorts by proficiency:** weapons you're trained with
  sit up top under "✔ Proficient"; the rest fall under "✘ Not proficient (−4 to
  hit)" rendered in **burnt orange**. Switch class and the list re-sorts on the
  spot. Every AI's default weapon is one their class can actually use.

### 🧹 Topbar declutter + money menu
- The management buttons (**Sit out / Switch / Leave / Reset / + Bot / Pick AI**)
  now collapse into a single **≡ menu** on every screen size — not just phones —
  so the topbar isn't a long row of buttons anymore.
- **Re-buy moved into your 💰 money menu** (click your chips), right next to
  "Hit the Dungeon" — it's a money action, so it lives with the bank now.
- **Pick AI seats characters as you click them** and *keeps the picker open*
  (just like recruiting allies in the dungeon), so you can pack several in a row.
  Each one you seat drops off the list. **Fill empty seats** still fills the
  whole table and closes.

### ⚔️ Pathfinder 1e classes & weapons (dungeon / cosmetic fights)
- **Pick a class and a weapon.** Click your own name (the profile cluster, next
  to pronouns) to choose from all **38 PF1e base classes** and a roster of staple
  weapons — **dagger, shortsword, longsword, greatsword, warhammer, battleaxe,
  greataxe, longspear, quarterstaff, unarmed, katana, scimitar, rapier, polearm,
  whip**. Everyone starts with a **masterwork Dagger**.
- **"+1 weapon" now means YOUR weapon, upgraded.** A weapon enhancement is a
  flat +1/+2/… that rides on whatever you chose — no more being forced into a
  longsword. Each staple keeps its true PF1e dice & crit (greataxe 1d12 ×3,
  greatsword 2d6, rapier 18–20, …), pulled straight from the Pathfinder data.
- **Class drives Base Attack Bonus.** Your to-hit in the dungeon (and the
  cosmetic bar-brawl) now uses real PF1e BAB — a fighter swings better than a
  wizard of the same level. The NPCs have fitting classes too: Sirona the
  paladin, Gaspar the inquisitor, Tar-Baphon the wizard, Bujon the sorcerer,
  Kelda the rogue, Kate & Toni the magi, and more.
- **Smite Evil & Sneak Attack are live.** Enemies now carry an **alignment**, so
  **paladins smite evil foes** for bonus to-hit and damage. Everyone (heroes and
  monsters) tracks **flat-footed** status, so **rogues land Sneak Attack** on a
  foe that hasn't acted yet. (All of this is dungeon/flavor only — it never
  touches poker chips, pots, or standing.)

### ♠️ Bots — a little "mood"
- Each bot now has a small mood that **drifts hand-to-hand** — some hands they're
  feeling a touch braver (fold a bit less, open a hair more), some a touch more
  cautious. It's subtle by design, just enough that the AI don't feel like fixed
  formulas and play a bit more like people having good and bad days.

### ♠️ Bots — looser preflop (cheap to see a flop)
- AI were folding too much before the flop. Now a **cheap call (≈25–75g, up to 1.5
  big blinds) limps them in** with almost any playable hand (~80% of the time, vs
  ~20% before) to see a flop — while a **real early raise still folds the weak
  stuff** (~85–90%). Lots more action without bots calling off big raises with junk.

### 🐉 Dungeon — 16 new monsters (animals, aberrations & more)
- A big diversity pass with real Foundry token art, filling out the mid-to-deep
  CR bands (and the previously-empty CR 7–8): **Dire Ape, Ettercap, Dire Boar,
  Harpy, Gargoyle, Minotaur, Basilisk** (petrifying gaze), **Winter Wolf, Wood
  Golem, Bog Brute, Dire Bear, Chimera, Hill Giant, Medusa** (petrifying gaze),
  **Stone Giant,** and an eldritch **Abyssal Horror.** All on true PF1e stats, so
  the deeper you go the nastier — and more varied — the rooms get.

### 🥋 Dungeon — enemy Monks (with kiai)
- A new **Monk** foe (CR 2) throws a **flurry of unarmed strikes** and screams a
  random **Bruce-Lee-style kiai** on every swing (a different "wataaah!"/punch
  each time). Each Monk wears a **random face** from a motley dojo of races and
  ages — human, dwarf, orc, half-orc, tiefling, goblin, hobgoblin, and a couple of
  cameos. Especially great heard **muffled from up at the poker table.**

## 2026-06-01

### 🎲 Dungeon — AI only rolls for loot it would actually use
- AI allies no longer roll on every magic item — they **pass unless the drop is a
  real upgrade** for them (better than what they already wear in that slot). No more
  bots winning gear just to hock it; if nobody wants an item, it's hocked into the
  shared pool as before.

### 🩸 Dungeon — going down isn't dead yet (dying at 0, slain at −10)
- Drop to **0 HP or below and you're DOWN and dying, not dead** — you can't act,
  but you're **not out of the run**. You only die for real at **−10 HP**. Applies
  to humans and AI allies.
- **Cure potions can revive the downed** — a dropped potion now prioritizes the
  most-hurt member *including* anyone bleeding out, hauling them back to their feet
  if it heals them above 0. So clear the room, grab the potion, and your friend's
  back in the fight.
- Party cards show a pulsing red **🩸 DYING** state (with negative HP) — distinct
  from a greyed-out dead/left member. If the *whole* party goes down **in combat**,
  they bleed out and the run ends.
- A downed ally still counts: they **bleed 1 HP per room** (so heal or extract them
  before −10), they can **still roll for and win loot**, and they're owed a **share
  of the gold**. If the party **retreats (bails) before they take another hit**, the
  dying are **dragged out with their share** instead of being left to die.

### 🐉 Dungeon — real Pathfinder 1e monster stats (no more monster levels)
- Monsters now use their **true PF1e stat blocks** (AC, HP, attack, damage, saves,
  CR) instead of an artificial per-room level. **Difficulty comes from which
  creatures a depth can spawn** and from designated bosses — not from buffing the
  same mooks. Monster cards now show **CR**.
- **The room-by-room curve uses Pathfinder CR**, creeping **~0.25 CR per room** —
  CR ¼ creatures at the door, ~CR 2 by room 8, ~CR 3 by room 12, the CR 4–6 horrors
  deep down — with bosses as deliberate spikes above the curve.
- **New bosses:** the **Brass Golem** (CR 9, two 2d10+9 slams) guards **rooms
  8–12**, and the **Barbed Devil** (CR 11) lurks in the deepest rooms. Multi-hit
  and multi-die attacks (golem/ogre/ettin slams, devil claws) are modeled properly.
- Per-monster **paralysis DCs** (ghoul 13, ghast 15) and **spell DCs** (kobold
  shaman's Hold Person, DC 13) replace the old level-derived numbers.

### 💎 Dungeon — loot follows Pathfinder treasure-by-CR
- Magic-item drops are now keyed to the **encounter's CR** (the room's toughest
  creature), not raw depth — modeled on PF1e treasure tables. Weak rooms rarely
  yield magic (mostly coin); **+1 items become common around CR 4+**, and the best
  enhancement scales up (**+2 at CR 7–9, +3 at CR 10–12, +4/+5 deeper**), with
  lesser items far likelier than great ones. **Bosses always drop at least one
  magic item, and it's +1 or better** (tier still scales with their CR) — so the
  Brass Golem and Barbed Devil are guaranteed gear.

### 🧪 Dungeon — cure potions in the loot
- Rooms can now drop **Potions of Cure Wounds** (separate from gear, so the boss
  gear guarantee stands). They're **auto-rolled and quaffed by the most-hurt
  ally**, with the heal noted in chat. Strength scales with the room's CR —
  **Cure Light (1d8+1)** early, **Moderate (2d8+3)** mid, **Serious (3d8+5)** in
  the deep/boss rooms. If everyone's already healthy, the potion is hocked for gold.

### ⚔️ Dungeon — characters fight like real adventurers now
- We don't roll ability scores, so every character is assumed to have an **18 in
  their attack stat → a flat +4 to hit and +4 to damage** (doubled on a crit, like
  any stat mod). That was the missing "STR/DEX" piece — a fresh delver now actually
  *lands* hits on wimpy monsters instead of flailing.
- On top of that, characters add **½ their level (rounded down)** to **melee damage**
  and to **initiative**, so gear keeps paying off as you go deeper.
- Net: a gearless Lv 1 swings at **+5 to hit** for a solid 5–8 a pop; magic weapons
  stack their **+N to hit and damage** (the damage doubling on crits) right on top.

### 🛡️ Everyone wears a Chain Shirt now (+4 AC baseline)
- All characters — human **and** AI — start with a free mundane **Chain Shirt
  (+4 AC)**, before buying anything. Purchasing **Full Plate** replaces it; if you
  **hock your Full Plate**, you drop back to the chain shirt (not bare skin). The
  bank and seat cards label the baseline so it's clear you're never unarmored.

### 🗡️ Dungeon — character levels (gear-based)
- Every delver (human **and** AI ally) now has a **level = 1 + the total of their
  magic-item bonuses** (minimum 1). So a **+1 ring and a +1 sword make you Lv 3**.
- **Level drives the sheet:** **HP = 10 × level**, **+level to hit**, and
  **+level to saves**. A gearless Lv 1 starts at 10 HP; gear makes you tankier
  and deadlier. Picking up loot mid-run **re-levels on the spot** (more max HP,
  healed, better hit/saves). Level shows on the party cards and in chat.

### 🗡️ Dungeon — enemies have levels too
- Foes now scale with depth: **enemy level = room # ÷ 2** (rounded down). Room 1
  is Lv 0, rooms 2–3 Lv 1, and so on — adding to their **attack rolls and saves**
  (replacing the old flat monster buff with proper depth scaling). HP stays
  species-based. The room banner shows the foes' level.

### 🗡️ Dungeon — kobold warband
- New kobold variants with real Foundry token art: **Spearmen** (1d6 spears),
  **Shamans** who cast **Hold Person** — fail a Will save (DC 10 + ½ their level)
  and you **lose a turn** — and **Rogues** who **stab twice** for 1d3 with a
  signature dagger sound. Also gave the **dire rat** its proper token at last.

### 🎭 Banter — Auren Vrood's "Golarion-Dracula flow"
- Auren Vrood keeps his cold, clipped default, but when he **taunts or retorts**
  he now unfurls grandiose, surreal Golarion braggadocio (used sparingly, never
  the same twice).
- **Fixed a banter glitch** where the in-setting "god → gods" filter mangled
  ordinary lines (e.g. "I play like a **gods**"). It now only rewrites the
  Earth-monotheist phrasings and leaves grammatical "a god / like a god" alone.

### 🗡️ Dungeon — magic-item loot roll-off
- When a magic item drops, the party now **rolls for it**: each member chooses
  **🎲 Roll d20** or **Pass**, highest roll wins (ties re-break). Idle players
  auto-pass after 20s; if everyone passes, the item's left behind. **AI players
  always roll** and **auto-hock** anything they don't need (equip only a real
  upgrade), with the gold going into the shared pool. Works by voice too
  ("roll" / "pass") and keyboard (R / P) for blind players.

### 🗡️ Dungeon — recruit AI allies
- A **Recruit AI allies** panel now appears in the dungeon (same card style as the
  poker "Pick AI" picker), listing only **unseated** bots — so you don't pull
  anyone out of an active poker game. **50g each** (paid to the ally), up to **3**.
  They join the party, auto-fight on their turns, roll for loot (and auto-hock
  what they don't need into the pool).

### 🗡️ Dungeon is co-op now
- **Party up:** one shared run per table — anyone who hits the dungeon joins the
  same delve. **Everyone takes one turn per round** in initiative order; you act
  on your turn, others act on theirs.
- **The poker table keeps running** the whole time (you just vacate your seat).
- **10-second AFK auto-pass:** idle on your turn and you simply pass — the party
  plays on (no more auto-bail).
- **Per-member exits:** each player **bails individually** for an even share of
  the current gold pool; a downed player is out with nothing while the rest fight
  on. The run ends only when nobody's left. (Loot drops still go to one roll-off
  winner.)

### 🗡️ Dungeon — combat tuning + UX
- **Spells are per-room now:** 1 Lightning Bolt + 1 Stinking Cloud each room
  (refilled when you open a door), attacks unlimited — replaces the fiddly
  round cooldowns.
- **Ghouls & ghasts paralyze:** if one hits you, save (DC 14, +ring/+cloak) or
  **lose your next turn**.
- **Roll breakdowns are shown** in the dungeon log — every attack and save reads
  like `[d20 14 +3 = 17 vs AC 15]` (spoken narration strips the math for clarity).
- **Monsters buffed:** +to-hit and +saves (they were missing and failing
  lightning saves too often). Tunable from the new dungeon.jsonl logs.
- **Combat log is newest-first** and scrollable — latest action on top, scroll
  down for the run's history (buffer raised to 150 lines).

### 🗡️ Dungeon — blind support, harsher loot, sickened rules, logging
- **Blind mode can play the dungeon by ear + voice.** Spoken narration of rooms,
  enemies (with HP + numbered targets), your turn, combat results, loot, and the
  run's end; voice commands ("dungeon" to enter; then attack / attack two /
  lightning / stink / open / bail / read / hp / gold); plus full keyboard play on
  the dungeon screen (1-9 target, A attack, L lightning, S stink, O door, B bail).
- **Sickened enemies** (Stinking Cloud) now **lose their turn entirely** and are
  **+2 to be hit** — making the cloud a real tactical tool.
- **Loot is rarer & slower:** early-room drops ~1.5% (was 6-25%), and findable
  tier is depth-capped (+1 at depths 1-3, +2 at 4-7, +3 at 8-11…). Only one
  character claims a drop (party members roll off).
- **More melee variety:** +12 sword hit/block/swing SFX from the Foundry library.
- **Real backdrop:** the Carrion Crown **Harrowstone dungeon** battlemap.
- **Logging:** runs record to `dungeon.jsonl` for troubleshooting + tuning.
- Combat sounds are now a **single channel** (toggle + volume) like the others;
  "Hit the Dungeon" lives in the money dropdown (🏋️); blind icon is now an 👂.

### 🗡️ NEW: "Hit the Dungeon" side-game (beta — solo MVP)
- A push-your-luck dungeon crawl beneath the poker hall. Hit **🗡️ Hit the Dungeon**
  in the ≡ menu to leave your seat and descend: an endless room-crawl where you
  fight PF1e Ustalav monsters (menu combat — **Attack / ⚡ Lightning Bolt / 💨
  Stinking Cloud**), grab **gold** and the occasional **+1 magic item** (hock it
  or equip it), and **Bail** on your turn to climb out and bank your winnings.
  HP = 30 + 10 per ring/cloak bonus; deeper rooms are riskier and richer, with
  occasional bosses. Fall to 0 HP and you lose the run's gold + unbanked loot
  (but keep your chips and anything you equipped). Muffled poker drifts down while
  you're below; the table hears muffled thumps from the basement. It only ever
  *adds* gold to your stack — zero poker-mechanics impact. (Allies, AI mini-bosses,
  and real Foundry art/maps come in later phases — see docs/DUNGEON_DESIGN.md.)

### 💬 Chat — "jump to present" arrow
- Scroll up to read history and the chat now **stays put** instead of snapping
  back when new lines arrive (already the case), and a **▼ jump-to-present arrow**
  appears at the bottom of the chat. Click it to snap to the newest message. It's
  hidden while you're already at the bottom, and gently bobs when new chat lands
  while you're scrolled away. Thanks to **Tobias** for the request.

### 🔊 Card-deal animation — single composite deal sound
- The per-card flicks overlapped and sounded cluttered, so the deal now plays
  **one composite dealing sound** with the animation (kept the visual). Per-card
  audio is retained in the code, off for now, in case we revisit it.

### 🎴 Card-deal animation — cards land in position
- The hole cards no longer pop into each seat at the start of the hand and sit
  under the animation — they now **stay hidden until the flying card reaches the
  seat, then fade in as it lands.** So each player's cards appear to be dealt into
  place. (Reveal schedule is shared with the flight timing so they stay in step,
  even across the re-renders that happen mid-deal.)

### 🎴 Card-deal animation — tuned pace + real card sounds
- **Slowed the deal ~30%** for a more deliberate, readable pitch.
- The per-card flick now **fires as each card leaves the dealer's hand** (was on
  landing), so the sound lines up with the cards launching.
- Replaced the synthesized flicks with **six individual card hits cut (via ffmpeg)
  from the real deal recording**, level-matched — so the pitch sound is the actual
  cards. Played one per launched card.

### ⚡ Faster "Pick AI" picker
- Moved the picker's action buttons (**🎲 Random**, **🪑 Fill empty seats**,
  Cancel) from the footer up to a toolbar **above the character grid**, with
  Random first — so the common picks are one click away the moment it opens,
  no scrolling past the list.

### 🎴 Card-dealing animation
- At the start of each hand, card-backs now **pitch out from the dealer's seat to
  every player in the hand** — real-dealer order (one card to each going
  clockwise from the dealer's left, then a second pass), with a soft flick sound
  per card. Purely cosmetic (the real hole cards render underneath and the flying
  backs fade on landing). Auto-skips under `prefers-reduced-motion`, and there's a
  remembered **🃏 Card-deal animation** toggle in the audio settings menu (default
  on). The per-card flick uses **four purpose-built single-card SFX** generated via
  the 11labs sound-generation API (variety so the rapid deal doesn't sound looped).
  Thanks to **Tobias** for the idea.

### 👻 Farrah lore — Farrus Richton, the malevolent ghost
- Fixed Farrah's full name to **Farrah Delila Richton** and corrected her
  ancestry: Farrus Richton (the Butcher of Courtaud) is her **great-grandfather**.
  He's long dead but **haunts Ustalav as a malevolent ghost who hates everyone
  alive — except Farrah**, the one soul he dotes on. Added **Richton → "rick ton"**
  to the pronunciation list (applies to Farrah and Farrus).

### 🗣️ Pronunciation — Kovira, Kai Ginn, Gaspar, Fera
- The AI voices and blind-mode narrator now say these correctly:
  **Kovira** → *"koh vee rah"*, **Kai Ginn** → *"kai jinn"*, **Gaspar** →
  *"gas par"*, **Fera** → *"fear-ah"*.

### 🗣️ Pronunciation — "bilge"
- The AI voices and blind-mode narrator now say **"bilge"** correctly (rhymes
  with the "-ilge" in *build* → "bilj"), instead of mangling it into "bill-jah."
  Shows up often in the pirates' "bilge rat" insults. (Self-invalidates the TTS
  cache for any line containing the word, so old clips re-synthesize.)

### 🤠 New AI — Rodney "Danger" Smith
- Added **Danger** (Rodney "Danger" Smith), a CP-USS ranger / tracker / archer
  out of Courtaud — the marksman who put Auren Vrood in the ground at the Battle
  of Feldgrau. Works under Judge Daramid, runs with the CP-USS crew, and plays
  like a patient sniper (cautious): a good-natured redneck with a backwoods drawl
  and hunting metaphors for everything. Uses the "Nick" voice.

### 🐸 Elfrip — simpler, kid-like grammar (not stupid)
- Refined Elfrip's voice: he's **bright and good-hearted**, but speaks with the
  **simple, broken grammar of a small child / second-language speaker** — short
  plain sentences, dropped articles, present tense, third-person only. The ideas
  are sound; just the grammar is little-kid-ish. He also now openly **loves his
  friends** Kovira, Kate, Danger, Gaspar, Dismas, and Rissa (on top of big-sister
  Sirona) and cheers them on.

### 🗣️ Elfrip talks more, burps less
- Flipped Elfrip's chatter ratio: he now **speaks ~60%** of the time and **burps
  ~40%** (was burp-heavy at 75%). You'll hear more of his childlike goblin banter
  and fewer belches — the wet burp is now an occasional treat, not his default.

### 🦮 Blind Mode toggle in the options menu (mobile)
- You can now turn **Blind Mode** on/off from the **≡ options menu** (the one with
  + Bot / Pick AI / Re-buy / etc.), so phone and tablet players — who have no
  backtick key — can engage spoken play-by-play with a tap. The button shows its
  on/off state and stays in sync with the backtick shortcut and voice command.

### 🧑 New player
- Added **LeJeanBec** as a human player login.

### 👨‍👧 Farrah's adoptive aunts — Kate & Daramid
- Farrah (the orphan) now treats **Kate Blackwood** and **Judge Daramid** as her
  adoptive aunts — the closest thing she has to family. Her gleeful profanity
  softens into real affection around them; she calls them **"Aunty Kate"** and
  **"Aunt Judge,"** beams when they win, and defends them at the felt. Kate plays
  the indulgent, protective aunt; Daramid pretends to disapprove of the kid's
  mouth ("language, child") but is plainly proud of her.

## 2026-05-31 (later)

### 🎵 Gaspar quotes "The Gambler"
- Gaspar now deploys lines from the old gambler's ballad during play —
  *"know when to hold 'em, know when to fold 'em,"* *"know when to walk away,
  and know when to run,"* and the rest — deadpan, as folksy table wisdom, where
  the moment fits. Used sparingly so it stays a treat, not a tic.

### 🏆 Hall of Records — clearer "Gain" vs "Pot"
- Renamed **Win → Gain** and made it track **net profit** (chips gained after
  your own contribution), so it's clearly distinct from **Pot**, which is the
  **largest pot anyone won** (the full pot size). A player who wins an 11k pot
  but put in half their own chips shows ~5.5k Gain and 11k Pot. Biggest Loss is
  still net chips lost. Thanks to **Tobias** for the clarity nudge.

### 🏆 Hall of Records — records since the last reset
- The Hall of Records now counts **only hands played since the most recent big
  reset**, not all-time. Every Full Reset and Loot Lord win writes a boundary into
  the hand log and clears the board, so old records (e.g. a giant pot from a
  previous game) no longer linger. Thanks to **Tobias** for catching a stale pot
  record that predated the last reset.

### 🗣️ Pronunciation
- **Rhyarca** is now spoken as *"ree ark ah"* by the AI voices and the blind-mode
  narrator.

## 2026-05-31

### 💸 11labs token savings — TTS audio cache
- **Reused voice lines are now free.** Every synthesized line is cached to disk
  (keyed by voice + settings + exact text); when a character says something they've
  said before — "Fold.", "Mine.", a victory line — we replay the saved MP3 instead
  of calling 11labs. Saves characters/tokens, plays instantly, and self-prunes via
  an 80 MB-per-voice LRU so one-off conversational lines age out. Hit-rate at
  `/api/tts-cache`; optional one-time pre-warm script seeds the common lines.

### 🏆 Hall of Records (right panel)
- The leaderboard now shares its panel with an all-time **Hall of Records**:
  **🥇 Biggest Win**, **💀 Biggest Loss**, **💰 Biggest Pot**, **⚔️ Longest War**
  (most raises in a hand), **🃏 Biggest Bluff** (biggest pot stolen with junk), and
  **🐟 Ugliest Winner** (weakest hand to win a showdown — e.g. winning on Ace-high).
  Tracks current roster players only, and counts **only the current game** — every
  big reset (Full Reset or a Loot Lord win) starts the records fresh.

### 🧠 AI tells
- **Intelligence rings on AI tokens** — a subtle bronze / silver / gold ring around
  each bot's token shows its skill tier (low / average / high) at a glance.

### 🔮 Spells & 🎙️ voices
- **Spells no longer fizzle.** A gearless caster's bolt used to do nothing; spells
  now always cast (minimum power) — only the target's save varies.
- **Ulfred** is now voiced by **Sean**.

### 🧠 Smarter AI
- **High-intelligence bots rebalanced toward value.** A log study (13.7k
  decisions / 1.5k hands) confirmed the intelligence tiers work — high-intel is
  the only net-winning tier — but it was *over-bluffing* at a ~6.5:1 bluff-to-
  value ratio, the most exploitable leak there is. High-intel now **bluffs less,
  value-bets thinner, and won't bluff into a multiway crowd**, bringing the ratio
  to roughly balanced. It plays smarter, not just louder. (Average/low tiers
  unchanged.)

### 🗣️ Banter & chat
- **Bots answer to their name.** Mention a seated AI by name in chat ("nice hand,
  Vaughan") and *that* bot replies directly. A close-but-unsure match ("vaughn")
  gets a "did you say my name?" from the nearest bot. No name = no reply, so it's
  not chiming in on everything. (Short names need an exact match, so "late" won't
  wake up Kate.)
- **Wider poker vocabulary.** Bots now rotate through many ways to say each poker
  concept (busted draw, bluff, the nuts, bad beat, tilt, …) instead of leaning on
  one phrase, for more conversational variety.

### ⚔️ Combat
- **Cleaner fight lines.** Now that the system's proven out, the d20 / save / DC
  roll breakdowns are gone from chat — just the narrative result with the damage
  number (the dice still roll under the hood).

### 🔊 Audio
- **Separate combat-sound toggles** in the 🔊 audio menu — **⚔️ Sword & dagger**,
  **⚡ Lightning bolts**, and **💨 Farts** can each be turned off independently
  (so you can mute the farts without losing the swordfights, etc.). All three
  default ON and persist per-player.

### 🐛 Fixes
- **Full Reset now resets everyone.** "Full reset" was only zeroing *humans'*
  banks and never wiping gear, so the leaderboard still showed bots (and geared
  players) with their old wealth. It now resets **every** player — humans and
  bots — to the default 5,000 gp, clears all gear, zeroes rebuy debt, and wipes
  lifetime stats, so the whole board flattens to 5k.
- **Auto-fold timer no longer strands the table.** Fixed a bug where a human's
  120-second auto-fold timer could outlive its turn (when the next actor was a
  bot) and later null out the wrong player's clock — leaving the table "stuck at
  0 seconds." The timer is now always cancelled before the turn moves on.

### 🧑 Roster
- Added human players **Pinkey** and **Punkers**.

---

## 2026-05-30

### ♿ Blind-support overhaul (accessibility)
- **Selectable seats:** empty seats are now proper focusable buttons
  (`role=button`, Tab-reachable, Enter/Space to sit) with a clear "Sit down in
  seat N" label — screen readers announce and operate them directly.
- **Hear your hand on demand:** press **H** (or say "hand") any time to re-read
  your hole cards and the board. Your cards are still announced the moment
  they're dealt and again when the action reaches you.
- **Full play-by-play:** every opponent action is now narrated tersely —
  "Kate folded.", "Nomkath called 50 gold.", "Mr. Brow raised 400 gold.",
  "Nomkath all in." — so a blind player can follow the table without watching it.
- **Your-turn controls:** the first time it's your turn each session, blind mode
  reminds you how to act (hold the talk key and say fold / call / raise; press H
  for your hand).
- **Push-to-talk, your way:** hold the talk key (default **Space**) and speak
  "fold" / "call" / "raise 500" / "all in". The key is **rebindable** — say
  "change push to talk" and press your preferred key (saved across visits).
- **Hands-free seating:** say "sit" to take the first open seat, or "sit seat 3".
- **Terser money read-out:** narration drops the word "gold" and just speaks the
  number ("Kate called 50.", "raised 400.") to keep the cadence quick. Your own
  chips are read as **"cash"** rather than "stack" ("Cash 2,730."), and your
  turn cue always includes the pot ("Pot 300.").
- **AI interprets unclear speech:** if push-to-talk says something the routine
  parser doesn't recognize ("I'm out", "bump it to five hundred", "see the bet"),
  the phrase is sent to the local AI, which maps it to an action — and blind mode
  reads back its guess for a yes/no confirm before anything happens, so a
  misheard command can never act on its own.
- **Talk over it (barge-in):** holding the talk key now instantly silences
  whatever blind mode is saying and listens to you — interrupt a long cue mid-
  sentence with "check" and it acts. Also stops the mic from mis-hearing its own
  narration.
- **Cash on demand:** your turn no longer reads your chips every time; say "cash"
  to hear them when you want. The pot is still read each turn.
- **Reliable raise amounts:** fixed a number-parsing bug where "five hundred"
  (which speech-to-text often writes as "5 hundred") came out as 5. Spoken
  numbers now combine digits and words correctly ("2 thousand", "fifteen
  hundred", "1.5k"), recognition weighs several guesses to favor real commands,
  and every raise/all-in is **read back for a yes/no confirm** before chips move.

### ⏱️ Faster pacing
- **Shorter showdown pause** — the gap between hands dropped from ~16.5 s to ~11.5 s
  (the winner/board now stays up for 10 s instead of 15). Override with
  `HAND_RESULT_PAUSE_MS` if you want it longer.

### ⚔️ The Duel update (cosmetic fights — pure flavor, never affects poker)
- **Fight gag:** hover another player's seat and click ⚔️ to swing your weapon at
  them. The target swings back, and AI players react in character (gloating if they
  out-hit you, indignant if they came off worse).
- **AI revenge swings:** bots now occasionally start fights themselves — a petty,
  cosmetic swing (or spell) at someone who **beat them** that hand, **bluffed them**
  out of a pot, or is a **lore enemy** (random old grudge). They taunt as they do it.
  Rare and human-present-only; tunable via `BOT_REVENGE_PROB` / `BOT_REVENGE_COOLDOWN_MS`
  / `BOT_REVENGE_ENABLED`. Lore grudges live in `backend/src/bot/enemies.js`.
- **D&D-style resolution:** d20 + weapon to-hit vs Armor Class
  (10 + Full Plate + Heavy Shield + Ring of Protection, from your purchased gear).
- **Weapons:** everyone starts with a **Masterwork Dagger** (1d4) until they buy a
  **Longsword** (1d8, +N). You can always throw a punch.
- **Pathfinder crit system:** both weapons threaten on **19–20** and require a
  **confirmation roll** to land a **×2** crit. Natural **1** is an auto-miss fumble
  (cue the "oof"); a confirmed crit doubles damage.
- **Sound effects** from the Foundry library: separate pools for whiff, blocked-by-
  armor (clang), and hits-flesh (eviscerate), plus the dagger swipe and fumble oof.
  Plays for everyone at the table.
- **Cash cap raised** to the price of the most expensive item (+5 Longsword,
  50,315 gp) so you can always save up for top-tier gear.

### 🔮 Spells, spectators & a chat fix
- **Two new attacks** on the seat hover menu (alongside ⚔️):
  - **⚡ Lightning Bolt** — DC 10 + your total magic bonus; target rolls a Reflex
    save (d20 + their Cloak of Resistance). Damage is 1d6 lightning per point of
    your total magic bonus, halved on a save. (No magic items? It fizzles.)
  - **💨 Stinking Cloud** — same DC, a Fortitude save instead; failure leaves the
    target **sickened** (a cosmetic 🤢 status). Cue the appropriate sound effect.
  - **More variety:** both spells now pull from a **pool of randomized sounds**
    (7 thunderclaps/zaps for Lightning Bolt, 8 assorted farts for Stinking Cloud)
    so they don't sound identical every cast.
- **Spectators** now appear as tokens at the **top-center** of the table; if too
  many to fit, the row collapses to just names.
- **"Fill empty seats"** option in the Pick AI menu — packs every open seat with a
  random AI in one click.
- **Searchable Pick AI menu** — the bot picker now has a **search box** (auto-focused
  on open) that live-filters the now-**alphabetized** roster by name, with a running
  match count. **Enter** seats the first match, **Escape** closes — fast keyboard flow
  for finding a specific character among 40+.
- **Fixed: chat sometimes froze (or never started) until a refresh.** Chat line IDs
  reset on every server restart, so the client's "already seen" list silently
  dropped the new lines. IDs are now unique per server run, so chat keeps flowing
  across restarts/deploys.

### 🤖 Idle tables
- When **nobody is seated or spectating**, the AI players leave after the current
  round instead of grinding hands to an empty room (saves resources). They come back
  when someone shows up.

### 🗣️ Voices & banter
- **Higher-quality AI voice model** for fuller, more natural delivery (fixed the
  rushed/pitched-up voices); calmer per-character tuning for a few bots.
- **Accurate money talk:** bots now quote exact bet/pot/debt figures (no more
  garbled numbers) via spelled-out amounts + value substitution.
- **Hallucinated-figure scrub:** as a safety net, if a bot ignores the rule and
  blurts a literal money number anyway (Estovion once announced "fifty-two
  hundred" out of nowhere), it's now auto-corrected to the real amount it's
  reacting to — or dropped to a vibe if there isn't one. Flavor numbers (gear
  bonuses, "thirty percent", card ranks) are left alone.
- **Poker sense:** bots stopped mocking small/correct calls and now save the roasts
  for genuinely bad plays; sharper, more characterful reactions to big raises.
- **Action discipline:** folded players no longer announce "check"/"call"; the
  player actually checking may say it.
- **Lots of new lines:** punchy victory lines for the whole roster, sore-loser
  quips, expanded Pathfinder-deity oaths and curses, and a cleaned-up insult list.
- Toned down Kovira's lisp so her lines stay readable.

### 📜 Characters & lore
- **Kill-Steal pirate crew** made internally consistent — Captain Storgrim, first
  mate Holden, helmsman Rhyarca, boatswain Vaughan, ship's wizard Bujon, ship's bard
  Conchobar — with cross-references and relationships.
- **Kate ↔ Daramid** attorney/judge dynamic ("Objection!" / "Overruled.").
- Reworked backstories: Sirona (angel of Sarenrae), Estovion (Ardis ex-con, secret
  favor to the Whispering Way), Tokala (adamantine chainsaw, Grease), and more.

### 🔧 Under the hood
- **Conversation log** — a full timestamped transcript of banter + gameplay for
  tuning and debugging.
- Pronunciation fixes for several character names and longer pauses on divine oaths.
