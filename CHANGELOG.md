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
  from a greyed-out dead/left member. If the *whole* party goes down at once, they
  bleed out and the run ends.

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
