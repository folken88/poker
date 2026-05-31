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
