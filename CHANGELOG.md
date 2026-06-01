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

### 💬 Chat — "jump to present" arrow
- Scroll up to read history and the chat now **stays put** instead of snapping
  back when new lines arrive (already the case), and a **▼ jump-to-present arrow**
  appears at the bottom of the chat. Click it to snap to the newest message. It's
  hidden while you're already at the bottom, and gently bobs when new chat lands
  while you're scrolled away. Thanks to **Tobias** for the request.

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
