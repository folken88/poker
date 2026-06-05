# Folken Poker

Multiplayer Texas Hold'em for me and friends. Hosted at <https://poker.folkengames.com>.

One persistent table. Whoever shows up sits down. A roster of named **AI bots** (43 of them, each with a personality + intelligence tier + optional 11labs voice) fills empty seats and plays. Bots wear the faces of PCs and villains from my long-running Pathfinder campaigns — tokens are copied permanently into the project so the poker game has no runtime dependency on FoundryVTT. When the LLM banter system is enabled, each bot speaks in their own voice using ElevenLabs synthesis (or stored sound clips for non-speech characters — Crisp's velociraptor chirps, Elfrip's burps).

## Stack

- **Backend**: Node 20 + Express + Socket.IO + better-sqlite3 + pokersolver
- **Frontend**: Vanilla HTML / CSS / JS. Programmatic SVG cards, no framework, no build step.
- **Container**: nginx (static + WS proxy) + node (game server). Two containers, one compose file.
- **Host port**: 32086 → Traefik → `https://poker.folkengames.com`

## Run

```bash
docker compose up -d --build
# UI: http://localhost:32086  or  https://poker.folkengames.com
```

## Layout

```
poker-game/
├── backend/                       # node game server
│   ├── src/
│   │   ├── server.js              # Express + Socket.IO bootstrap
│   │   ├── game/
│   │   │   ├── Table.js           # seats, current Hand, bot driver, AFK + action timers,
│   │   │   │                      #   per-action chat, bot auto-invest, Loot Lord ceremony
│   │   │   ├── Hand.js            # state machine: preflop → flop → turn → river → showdown
│   │   │   │                      #   plus fold-win reveal (winner's hole cards always shown)
│   │   │   ├── Deck.js            # shuffle + deal
│   │   │   ├── Pot.js             # side-pot math
│   │   │   └── actions.js         # action validator (fold/check/call/raise/all-in)
│   │   ├── bot/
│   │   │   ├── Bot.js             # heuristic decision engine — risk (mode) × intelligence,
│   │   │   │                      #   wealth-aware ctx, per-opponent bluff memory,
│   │   │   │                      #   high-intel slow-play of monsters on early streets
│   │   │   ├── strength.js        # Bill Chen preflop + pokersolver rank/10 postflop
│   │   │   ├── banter.js          # LLM-driven ambient chat (system prompt assembly,
│   │   │   │                      #   pantheon profanity menu, insult vocab,
│   │   │   │                      #   Elfrip burp/talk split, length cap)
│   │   │   ├── character_voices.js # nickname → 11labs voice_id map + voiceFor() with
│   │   │   │                      #   Vorkstag's impersonation routing + Dracula fallback
│   │   │   ├── character_sounds.js # stored sound pools (Crisp chirps, Elfrip burps)
│   │   │   │                      #   used in place of TTS for non-speech characters
│   │   │   ├── voiceIntent.js     # LLM fallback that maps unclear blind-mode speech
│   │   │   │                      #   to a poker action (blind:interpret socket event)
│   │   │   └── roast_styles.js    # targeted comedic-influence overlays (dracula-flow
│   │   │                          #   for the gothic-horror trio, simple-speaker for
│   │   │                          #   Elfrip/Crisp, jeff-ross+giraldo for Kovira)
│   │   ├── persistence/
│   │   │   ├── db.js              # SQLite, roster + bot roster seeding, chip + gear +
│   │   │   │                      #   gender persistence, one-shot migrations
│   │   │   ├── schema.sql
│   │   │   └── logger.js          # JSONL hand history + bot-decision logs
│   │   ├── util/
│   │   │   ├── elevenlabs.js      # 11labs TTS client (server-side only; API key in .env,
│   │   │   │                      #   never client-bound; rate-limited; pronunciation
│   │   │   │                      #   overrides applied before API call)
│   │   │   ├── ttsCache.js        # on-disk exact-text mp3 cache (per voice+model+settings)
│   │   │   └── linePool.js        # per-(character,event) pool of past voiced lines —
│   │   │                          #   replays saved mp3s (v2/v3-tagged) to skip LLM+11labs
│   │   └── sockets/
│   │       ├── lobby.js           # choose player, set avatar, set pronouns, gear buy/sell,
│   │       │                      #   audio prefs broadcast, reset, debt
│   │       └── table.js           # join, action, request-hole, add/pick/kick bot or human,
│   │                              #   sit-out / rejoin, human chat input
│   ├── data/                      # SQLite file (mounted volume; gitignored)
│   ├── logs/                      # JSONL append-only logs (gitignored)
│   ├── Dockerfile
│   └── package.json
├── public/                        # static UI (served by nginx)
│   ├── index.html
│   ├── css/table.css
│   ├── js/{client,cards,avatars}.js
│   ├── js/blindMode.js          # screen-reader narration + push-to-talk voice control
│   ├── tokens/                    # all character art (140+ webp files)
│   └── assets/avatars/            # 12 preset SVG avatars for humans
├── nginx/nginx.conf
├── scripts/
│   ├── import-vault-tokens.js     # one-shot importer (see below)
│   ├── token-overrides.json       # manual PC → token mappings
│   └── villains.json              # iconic villain roster tier
├── docker-compose.yml
└── README.md
```

## Architecture

- **All authoritative game state lives on the server.** Clients send action *intents* (fold, call, raise N), never state.
- Each player's hole cards are emitted only to that player's socket — never broadcast. Reconnects re-request them via `table:requestHole`.
- One Socket.IO room per table. Spectators get public events but never private hole-card events.
- Identity: per-tab sessionStorage cookie + chosen nickname from a fixed roster. Chips persist per `player_id` (lowercased name). No auth — anyone clicking "Fred" is Fred for that tab.
- **Broadcast discipline**: `applyAction` and `start` mutate all state (chips, timers, `nextHandAt`) **then** broadcast exactly once. No intermediate emits with stale deadlines.

## Game features

- 9-seat ring on a flatter ellipse. Programmatic SVG cards, dark felt-green theme.
- **Persistent table** — newcomers wait for the current hand to end, then are dealt in.
- **Seats survive disconnects**. Your chips + position are reserved; refresh and you're back where you sat.
- **AFK detection** — players who haven't acted are skipped at deal time and don't pay blinds.
- **120-second action timer** for humans. Time out = auto-fold (or auto-check when free). Bots have their own mode-flavored thinking delays (risky 1d4s, standard 1d10s, cautious 1d15s, hard-capped at 30s).
- **Bot driver safety** — `bot.decide()` is wrapped in try/catch and `applyAction`'s result is checked. On throw or rejection (invalid action e.g. `check` when `toCall>0`), the bot force-folds and the full state context (action, toCall, currentBet, minRaise, stack) is error-logged so the broken decision branch is debuggable. Previously a bad decision would silently strand the table with no recovery.
- **Side pots** when someone is all-in. Showdown awards each pot independently.
- **Fold-win reveal** — even when everyone else folds, the winner's hole cards flip face-up so opponents can see if it was a bluff. Description auto-tags obvious bluffs ("Ten-Two off — total bluff").
- **Sit out / Rejoin** — keep your seat but skip deals until you're ready.
- **Reset modal** — two options, BOTH kick every AI from the table:
  - *Cancel current hand* — refunds all bets, vacates every bot, human stacks unchanged, new hand auto-starts.
  - *Full reset* — same as above PLUS resets every player's chips to 5,000 and wipes gear.
- **× kick from spectator seat** — kicking a bot no longer requires the caller to be seated. Spectators can clear stale bots before sitting down. (Kicking a human still requires you to share the felt — has political weight.)
- **Pick AI picker** — the `+ Bot` / Pick AI modal lists every unseated AI (alphabetized, with current wealth) and has a search box (auto-focused, live-filtered, match count). Enter seats the first match, Escape closes. Plus **Random** and **Fill empty seats**.
- **Per-action chat log** — one line per turn (fold/check/call/raise/all-in) with chip amounts, plus winner announcements with revealed hand descriptions.
- **Human chat input** — type below the table log, Enter to send. Posts as `💬 Nick: text`. 240-char cap, 1.5s per-socket cooldown. **Name a seated AI** (fuzzy-matched, short names need exactness) and that specific bot answers you directly; a near-miss gets a "did you say my name?"; otherwise a ~5% random clap-back so it's not replying to everything.
- **× kick button** on every non-self seat — any seated player can boot any other (human or bot). Takes effect at end of current hand; chat announces who kicked whom (`🚪 Tobis kicked Mr. Brow — leaves after this hand.`).
- **Auto-yield seat** — when a human spectator joins a full AI table, a random bot is flagged to leave at hand-end so the human can sit on the next deal without waiting.
- **Vacate grace window** — when a seat opens up (kick / auto-yield / bust), the next-hand autostart pause extends from 1.5s → 5s so a watching spectator has time to click in. Topbar countdown reflects the longer wait.
- **Card sound effects** — shuffle between hands (randomized), deal on flop/turn/river, a soft per-turn tick on every actor change, plus a solo your-turn chime that fires only on your own client when the action lands on you. All SFX are volume-normalized.
- **Audio settings popover** (🔊 in the topbar) — per-player checkboxes for "card sounds" + "AI character voices" with matching **volume sliders** (0-100%). Settings persist per player in localStorage. Defaults: card sounds 45%, voices off.
- **Spectator chip** in the topbar — comma-joined nicknames of connected players who aren't seated (👁 prefix). Hidden when nobody's watching; capped at 260px width with full list on hover.
- **Pronouns dropdown** under your nickname — they/he/she. Persists via `lobby:setGender`; the LLM banter system reads gender from the roster broadcast and tailors pronouns when referring to characters by name. Bot pronouns are pinned in `BOT_ROSTER` and re-synced every boot.
- **Blind support mode** — a full screen-reader / voice play experience, toggled with backtick (`` ` ``). The Web Speech API narrates state tersely: a your-turn cue (hole cards + board + to-call + pot), a compact running play-by-play of every opponent action ("Kate folded.", "Nomkath called 50."), board reveals, and winners. Money is read as bare numbers. **Keyboard explore hotkeys** (no mic needed) let a blind player inspect anything on demand: **H** re-hear your hand · **C** your cards · **B** the board (or "Preflop") · **P** the pot · **M** your cash · **N** your bet this hand · **1–9** a seat (says who's there, or arms an empty seat so **Return** sits you) · **S** stop the narration instantly · **`[`** / **`]`** slow down / speed up the voice (persisted; defaults to a gentle 1.2×). **Push-to-talk** (hold a rebindable key, default Space) runs speech-to-text commands — "fold" / "call" / "raise 500" / "all in", plus "sit" / "sit seat 3" — and holding the key **barges in**, silencing narration so you can interrupt mid-sentence. Blind-mode activity is logged client-side (`window.BlindMode.getLogs()`) and, for allow-listed testers, streamed to `backend/logs/blind.jsonl`. Every raise reads its amount back for a yes/no confirm. Anything the routine parser can't place is sent to the local LLM (`blind:interpret`), which maps loose phrasing to an action (also confirmed before it acts). Empty seats are real focusable buttons, and your action controls auto-focus on your turn. Cooperates with 11labs character voicelines so the two never talk over each other. **NB:** the browser mic only works in a secure context — use `https://poker.folkengames.com`, not the raw host:port.
- **Dual-cell topbar clock** — the timer pill is split into two side-by-side cells. Left cell (blue) shows the action clock and its label ("action timer" / "next hand in"). Right cell (brass) shows the hand clock running total. Each cell has a fixed min-width so digits don't jitter when labels swap.
- **Winner banner (center stage)** — between rounds, the felt center shows the winner's avatar at 2× size, the chips awarded, and the winning 5-card combo sorted low → high using PF1e rank order. Doubled token size for this display only; box auto-fits.
- **Cash cap (20,000 gp)** — at hand-end, any seat over the cap is clipped back to 20k and the overflow is announced in chat. Forces wealth into gear instead of stockpiled chips.
- **Hock-required rebuy** — busted players can no longer accrue debt. To re-buy after going broke you must first sell off your magic items in the Loot Bank. The legacy `rebuy_debt` column is migrated to zero on boot. Each forced rebuy gets an embarrassing flavor line (pocket squirrel, slightly-used lute, etc.).
- **Folded bots can banter + give advice** — bots who have folded or are waiting their turn are eligible speakers for the LLM banter system. A dedicated `advice` event fires at ~8% probability whenever the action moves to a new actor, letting tablemates kibitz on the live decision.

## Goal: LOOT LORD

The win condition is to assemble a **+5 magic-item set in all 5 gear slots** at PF1e prices:

| Slot   | Item                   | +5 cost    |
|--------|------------------------|------------|
| Weapon | Longsword              |  50,315 gp |
| Armor  | Full Plate             |  26,650 gp |
| Shield | Heavy Steel Shield     |  25,170 gp |
| Cloak  | Cloak of Resistance    |  25,000 gp |
| Ring   | Ring of Protection     |  50,000 gp |
| **Total** |                    | **177,135 gp** |

First player to complete the +5 set triggers a 20-second **Loot Lord ceremony** (giant token reveal, countdown overlay), then the game resets — everyone back to 5,000 gp, gear cleared, hand counter reset. Champion is logged on the Champions Board.

Mid-game gear purchases happen via the **left-sidebar Loot Bank**. Each purchase deducts immediately from chips and is mirrored into the live in-hand stack so the post-hand sync doesn't undo it.

## Bots — risk × intelligence

The 43-bot roster lives in `backend/src/persistence/db.js` (`BOT_ROSTER`). Each bot has two orthogonal traits:

**Risk appetite** (`baseMode`):
- **cautious** — small sizing, high fold floor, doesn't shove except on near-nut hands (v ≥ 0.92).
- **standard** — balanced.
- **risky** — large sizing, low fold floor, shoves monsters, actively bluffs and probes.

**Intelligence**:
- **low** (±0.28 hand-read noise, 20% mistake rate, almost no deliberate bluffs)
- **average** (±0.10 noise, 10% mistakes, light bluffing)
- **high** (±0.03 noise, 2% mistakes, deliberate manipulation)

### Decision engine highlights (`backend/src/bot/Bot.js`)

- **Preflop strength**: Bill Chen formula normalized 0..1.
- **Postflop strength**: `pokersolver` rank / 10 plus draw bonuses.
- **Perceived strength** = true strength + intelligence-tiered noise. Low-intel bots can read a monster as marginal (or junk as a monster). High-intel bots see truth.
- **Mistake roll** — with intelligence-dependent probability, take a clearly suboptimal action (miss value, spew on junk).
- **Deliberate bluffs** — non-low intel bots gated on cheap-bluff conditions; risky 1.8× rate, standard 1.0×, cautious 0.3×. **High-intel is rebalanced toward value** (lower bluff frequency, thinner value bets, and no bluffing into a multiway crowd) after logs showed it over-bluffing ~6.5:1 — the most exploitable leak. It now plays roughly balanced.
- **Wealth-aware risk** — bots see opponents' chips + gear value. Richer bots size up; poorer tighten. Rich aggressors discounted (presumed bluff); poor aggressors respected. Weighted by intel.
- **Bluff memory** — per-opponent samples of revealed bluffs vs value bets. After every showdown / fold-win reveal, every bot at the table updates its memory of who committed ≥4 BB with what strength. At decision time, the aggressor's smoothed bluff ratio shifts the fold threshold up to ±0.12 (high intel uses fully; low intel barely uses it).
- **High-intel slow-play** — high-intelligence bots holding a true monster (v ≥ monsterThresh) on preflop/flop don't slam-shove like they used to. They check (60%) or small-probe at 0.35× pot (40%) when they can open, and flat-call when facing a bet — letting the pot build and opponents stay committed. On turn/river the existing monster-shove / patience-pays branches fire and they slam-dunk. Only triggers for `intelligence === 'high'` and only with true monsters; medium-strong hands play normally.
- **Mode drift** — at end of hand, 18% chance to shift mode; tends to drift back toward baseMode.
- **Bot gear auto-invest** — at end of every hand, bots spend excess chips (keeping ≥5,000 reserve) breadth-first: every slot at +1 before any +2, every slot at +2 before any +3, etc. Cheapest-affordable-first.

Every decision is appended to `backend/logs/bot-decisions.jsonl` for later analysis.

### Optional: LLM banter (Gemma + Ollama)

Decisions stay heuristic, but a local LLM can generate **ambient in-character
chat** when something interesting happens (big raise, all-in, bluff revealed,
big win). The acting player is excluded from the speaker pool, so you hear
opponents reacting — not the player narrating themselves.

Disabled by default. To enable, set these env vars on the backend container
(via `docker-compose.yml` or a `.env`):

```
LLM_BANTER_ENABLED=1
LLM_ENDPOINT=http://host.docker.internal:11434/api/chat
LLM_MODEL=gemma4:e4b
LLM_BANTER_COOLDOWN_MS=18000   # min gap per-table between lines
LLM_BANTER_PROB=0.30           # roll per trigger event
LLM_BANTER_TIMEOUT_MS=8000     # hard timeout on the HTTP call
```

Notes:
- Use the `/api/chat` endpoint, not `/api/generate` — only the chat
  endpoint applies the model's template, which is required for
  reasoning models like Gemma 4 to produce visible output.
- The request sends `think: false` so Gemma 4's `<thinking>` preamble
  is skipped — without it the model produces 100+ tokens of reasoning
  before its actual reply.
- First request after Ollama boots cold-loads the model (~30–70 s).
  Subsequent calls are ~0.5–2 s.

Bring up an Ollama server on the host (`ollama serve` + `ollama pull gemma4:e4b`),
then restart the backend container. If the LLM is unreachable for any reason,
the banter system silently no-ops — no breakage, no game-state impact.

Character flavor lives in `backend/src/bot/banter.js` (`CHARACTER_FLAVOR` map).
Each entry is a short bio injected into the system prompt. Add new
entries by exact nickname match; missing characters fall back to a
generic `${mode}/${intelligence}` template.

**System prompt structure** (assembled per speaker in `buildMessages`):
- Speaker identity (`You are X, [flavor]`) + pronoun line driven by the gender column
- Pantheon profanity menu — Golarion deities ONLY (Sarenrae, Cayden Cailean, Gorum,
  Shelyn, Pharasma, Desna, Iomedae, Calistria, Torag, Droskar, Brigh, Casandalee,
  Asmodeus, Norgorber, Nethys, Rovagug, Lamashtu) with go-to blasphemies per deity.
  Paladins / clerics constrained to their own deity, never a rival's. Earth profanity
  is fine standalone (`fuck/shit/damn`) but Earth deities are forbidden (no
  "Christ", "Jesus", etc.). Setting-flavored curses (`ghoul-shit`, `Worldwound take you`,
  `by Aroden's bones`, `Tar-Baphon's teeth`) also enumerated as deity-free oaths.
- Money-talk allowance — opponents' cash + gear value + Abadar debt + net worth are
  in the table context, free to comment on (`How much do you owe Abadar now?`).
- Insult vocab — short modern one-word jabs first (Rat / Worm / Cope / Cringe / Mid),
  then poker slang, general slights, and character-specific menus (pirate /
  dwarven / goblin / undead-villain / paladin). Explicit speaker-target matching
  rule — pirates don't say "mooncalf"; Tar-Baphon doesn't say "swab".
- Per-character roast-craft overlay (see `roast_styles.js` below) — only fires
  for the small curated set; everyone else carries voice through CHARACTER_FLAVOR alone.
- Length cap — most reactions 1-6 words, occasional fuller jab up to ~12, never
  speeches. "If you can't land it in a short phrase, you probably shouldn't say it."

**Roast styles** (`backend/src/bot/roast_styles.js`) — a tagged taxonomy of comedic
mechanics distilled from a real roast corpus (Greg Giraldo, Jeff Ross, Katt Williams,
Natasha Leggero, Nikki Glaser, Christopher Hitchens debate clips, PLUMMCORP's
"Dracula Flow" trap saga). Eight style guides:

| Style              | Mechanic                                                |
|--------------------|---------------------------------------------------------|
| `dracula-flow`     | Surreal self-mythologizing menace                       |
| `hitchens`         | Intellectual evisceration via argument-disqualification |
| `giraldo`          | Brutal compression, category-shift escalation           |
| `jeff-ross`        | Literal name-puns, composite-job descriptions           |
| `katt-williams`    | Pun cascades, courtroom-register subversion             |
| `leggero`          | Twee cruelty, warm-idiom payload swap                   |
| `glaser`           | Pause-pivots, pronoun-reversal mortality                |
| `simple-speaker`   | 1-4 word grunts + occasional dumb-zinger                |

Application is intentionally narrow (tried broad earlier, felt uniform & verbose):
- `dracula-flow` ONLY on the gothic-horror trio (Tar Baphon, Auren Vrood, Vorkstag)
- `simple-speaker` ONLY on Elfrip + Crisp
- `hitchens` only on canonically scholarly `intelligence:'high'` characters when used
- `jeff-ross + giraldo` on Kovira (warm default with anti-bully escalation mode)
- Everyone else uses CHARACTER_FLAVOR alone; the full guide menu stays in the module
  so we can add chars one-at-a-time when a style demonstrably fits.

**Elfrip burp/talk split** — Elfrip's banter routing is special-cased: 75% he just
burps (canned onomatopoeia text like `*BRRUUUAAHHHHHRP*` + a random burp clip from
`ELFRIP_BURPS`, NO LLM call, NO 11labs synthesis), 25% he actually speaks (LLM call
with his childlike-3rd-person flavor — `"Elfrip win?"`, `"Card not good for Elfrip"` —
plus his 11labs voice). The burp path short-circuits before the LLM so we don't
waste a model call generating English when we're about to broadcast a belch.

**Crisp noise-only path** — Crisp the juvenile velociraptor has no English at all.
100% short-circuits in `maybeSpeak` before the LLM: picks a random raptor onomatopoeia
(`*SKREEEEK!*`, `*hiss-hiss-hiss*`, `*KEK-KEK-KEK*`, `*tilts head*`, etc.) and pairs
it with one of his stored chirp / hiss / snarl clips from `soundFor('Crisp')`. The LLM
is never called for him so an English line can't leak into chat alongside the audio.

**Per-event probability override.** Different trigger kinds use different
fire rates so noisy events (a chatty human) don't flood the table:

| Event           | Probability   | Notes                                    |
|-----------------|---------------|------------------------------------------|
| raise / allin   | LLM_BANTER_PROB (default 0.30) | opponent reacts to the pressure |
| big call        | LLM_BANTER_PROB                | reaction to a notable defense   |
| winner declared | LLM_BANTER_PROB                | flagged extra if it was a bluff |
| human-chat      | **0.05**                       | low rate so bots only chime in occasionally |
| advice          | **0.08**                       | folded/waiting bot kibitzes on the live decision when action moves to a new actor |

The per-table cooldown (`LLM_BANTER_COOLDOWN_MS`, default 18s) still
applies on top of every roll.

### Character voices (ElevenLabs TTS)

When a bot speaks via the LLM banter system, the line is voiced through ElevenLabs
synthesis. Two modules drive the routing:

- **`backend/src/bot/character_voices.js`** — `nickname → voice_id` map plus
  `voiceFor(nickname, seat)`. Most characters use voices picked from the user's
  11labs library (Sam, Anika, Chloe, Dracula, Felix, Hannah, Sean, Verner Hishog,
  Mossbeard, Paul, Antoni, etc.); a handful use default 11labs voices when no
  custom voice is set.
- **`backend/src/bot/character_sounds.js`** — for characters whose "voice" isn't
  speech: Crisp the velociraptor (4 chirp/hiss/snarl clips), with Elfrip's burp
  pool exported separately so `banter.js` can pick the burp/talk path explicitly.

**Saving credits — the line-reuse pool (`backend/src/util/linePool.js`).** v3 voices
sound far better but cost more, so before paying for a fresh LLM + 11labs call,
`banter.js` may **replay one of a character's past lines** for the same event kind.
Each saved clip is a `{ text, mp3 }` pair, **tagged with its model version** (v2/v3)
and its specificity. The replay only fires when it fits: ~70% on a **perfect match**
(a generic line, or a dungeon bark against the same foe) once the pool has enough
variety, and only ~10% when it might not match (lines with a name/amount, or a
different enemy) — i.e. mostly generate-new when uncertain. Fresh lines are recorded
after a successful synth, so the pool (and the savings) grows over a session. Tunable
via `LINE_REUSE_PROB_MATCH` / `LINE_REUSE_PROB_LOOSE` / `LINE_POOL_MIN` /
`LINE_POOL_MAX`. The older `util/ttsCache.js` still does exact-text mp3 dedup beneath
this (a line voiced verbatim twice never re-synthesizes).

**Vorkstag's impersonation** — the skinwalker steals a tablemate's face AND voice
on sit-down. `Table.seatBot` picks a random other seat at sit-time, sets
`seat.avatarOverride` (visual disguise) + `seat.impersonatedNick` (voice/name
disguise). `voiceFor()` routes Vorkstag's lookup through `seat.impersonatedNick`
so he sounds like whoever he's wearing. If the impersonated target has no voice
mapped (humans / unmapped bots), he falls back to the Dracula voice rather than
going silent — silence would be a tell. Cash + gear values stay accurate on the
seat ("there is no fooling the church of Abadar").

**Pronunciation overrides** — names that 11labs and the browser Web Speech API
routinely butcher get phonetic spellings applied before synthesis:

**One source of truth:** `backend/src/util/pronunciations.js` holds the single
`PRONUNCIATIONS` list. The 11labs path (`elevenlabs.js` `applyPronunciations()`)
imports it directly; the browser blind-mode path (`public/js/blindMode.js`)
**fetches** it via `GET /api/pronunciations` on init. Add a name in that one
file and both TTS engines pick it up — no hand-syncing.

**Listener gate** — `Table.anyVoiceListener()` walks the room's connected sockets
and checks `socket.data.voiceOn`. If nobody at the table has voice enabled, the
11labs API call is skipped entirely to save credits — text banter still ships.

**TTS audio cache** (`backend/src/util/ttsCache.js`) — `synthesize()` checks an
on-disk cache before calling 11labs, keyed by `sha1(voiceId + model + voice
settings + exact cleaned text)`. A hit replays the saved MP3 for **zero** 11labs
characters (and skips the rate limit). Caches every line, bounded by an 80 MB
per-voice LRU (`TTS_CACHE_MAX_MB_PER_VOICE`) — frequently-reused stock lines stay
hot, one-off conversational lines age out. Lives in the persistent `data/`
volume; hit-rate at `GET /api/tts-cache`. Seed it from day one with
`node scripts/warm-tts-cache.js --go` (dry-run without `--go`).

**API key handling** — `ELEVENLABS_API_KEY` lives in `.env` (gitignored). Never
appears in any client payload, log line, URL, error message, or socket emission.
All synthesis happens server-side; clients only see resulting audio bytes.

### Roster sample

| Bot                     | Mode      | Intel    | Source              |
|-------------------------|-----------|----------|---------------------|
| Dinvaya                 | cautious  | high     | Aasimar Cleric      |
| Vaughan                 | risky     | high     | Half-Elf Magus      |
| Storgrim Thunderbeard   | cautious  | average  | Dwarf Fighter       |
| Kate Blackwood          | cautious  | high     | Skinwalker Magus    |
| Kovira                  | risky     | high     | Tiefling Arcane Trickster |
| Elfrip                  | standard  | low      | Goblin Cleric       |
| Mr. Brow                | risky     | high     | Iron Gods villain   |
| Crisp                   | risky     | low      | Velociraptor druid  |
| Kelda Ironglim          | cautious  | high     | Dwarf Rogue         |
| Tamsin                  | cautious  | high     | iconic              |
| Concetta                | risky     | high     | iconic              |
| …                       | …         | …        |                     |

Full list in `BOT_ROSTER` (db.js). Configuration is re-applied to every existing bot record on every boot — `BOT_ROSTER` is the source of truth.

### Reserved humans (never used by AI)

The human ROSTER (`ROSTER` in `db.js`) is treated as **human-only** — names like Tobis, Fred, Timmay, LEEESA, Sydness, BRION, Zachariah, Harry, Banana, Cram, Mandore, Kayla, Ash, etc. The `+ Bot` button and the bot picker modal both filter on `is_bot = 1`, so AI never plays these names.

## UI layout (desktop)

```
┌─────────────────────────── topbar ────────────────────────────┐
│ Folken Poker · ⏱ countdown clock · 💰 chips · re-buy · etc. │
├──────────┬───────────────────────────────────┬───────────────┤
│ 🎒 My    │             felt                   │ 🏆 Leaderboard │
│ Loot     │       (9-seat ring + board)        │ (live wealth,  │
│ Bank     │                                    │  all players)  │
│          │       [floating action panel]      │                │
├──────────┴───────────────────────────────────┴───────────────┤
│                  Table log (chat, per-action)                 │
└────────────────────────────────────────────────────────────────┘
```

- **Left** — your gear bank + buy/upgrade/hock buttons (collapsible via a brass-tinted clickable header — defaults to expanded so options are always reachable) and a Hand rankings reference list. Buttons sized for usability (≥34px min-height). Bank reads from the persisted roster record so it stays correct even between hands or while sat out.
- **Right** — live wealth leaderboard (chips + gear value, all 27 bots + humans). Updates on every roster event.
- **Centered chat column** — the bottom table log is centered to a 760px max-width column so long lines stay readable on wide monitors; text within each line stays left-justified.
- **Help / Actions / Position badges / Flow / Tips** — in the `?` modal in the topbar.
- **Seat gear popup** — opponents' magic items show on hover (popup below the seat, never affects layout). Player's own gear lives in the left-sidebar bank.

## Mobile (≤720px)

- Side panels hidden; help modal accessible via `?` button.
- Seats collapse to **token + name only** (64×96 px). Chips, gear, hole cards, timer (on non-actors), and AFK/sit-out tags are suppressed. The acting seat still shows its countdown.
- Action panel becomes a **fixed bottom toolbar**: Fold / Call / Raise / All-in in one wide row, raise input + preset chips. Drag handle, presets, bank/leaderboard toggles all hidden — they live in the perimeter on desktop, which is sufficient.
- A "my hand" strip in the toolbar shows your hole cards + chips + current bet.
- **Topbar overflow `≡` menu** — the management buttons (+ Bot, Pick AI, Re-buy, Sit out, Switch, Leave, Reset) collapse into a slide-down dropdown anchored to the topbar's bottom-right edge. Brass-bordered panel, 36px-tall tap targets, closes on outside-click / Escape / item-tap. Without this they wrap into 2-3 extra rows and the rightmost ones become unreachable. Desktop keeps the row inline.

## Character art import (one-time)

The bot avatars and any future PC-token assets live in `public/tokens/`. They are **not** drawn live from FoundryVTT — they were copied once via:

```bash
node scripts/import-vault-tokens.js
```

The script:
1. Walks Cassbot's Obsidian vault (`Documents/cass_discord_bot/obsidian_cass/cassvault/Characters/`).
2. Parses YAML frontmatter for PCs (`tags: ["pc"]`).
3. Indexes the local Foundry character art library (`F:/foundryvttstorage/foundryvtt-media/Art - Characters/`).
4. Scores filename matches against each PC's name (preferring `token_*` prefix, webp, known campaign folders).
5. Copies the winner permanently to `public/tokens/<slug>.webp`.

Manual overrides (when the auto-matcher picks the wrong file) live in `scripts/token-overrides.json` — keyed by exact PC name with the vault-relative path. Re-run the script after editing.

The villain tier (`scripts/villains.json`) is curated by hand — iconic NPCs from APs that round out the bot roster.

## Logs

- `backend/logs/hands.jsonl` — one line per completed hand: board, players, actions, winners.
- `backend/logs/bot-decisions.jsonl` — one line per bot decision: street, hand strength, mode, intelligence, chosen action, reason.

Both are append-only and gitignored.

## Deploy protocol (backend rebuilds)

The container restart kills any bot mid-thought and breaks the player's
sense of continuity. To avoid landing mid-hand, **wait for an explicit
`hand-complete` log marker** before recreating:

```bash
# 1. Build the new image (no service impact)
docker compose build backend

# 2. Block until the next hand actually finishes
docker logs -f --since 1s folken-poker-backend 2>&1 \
  | grep --line-buffered -m1 'hand-complete'

# 3. Recreate — we're guaranteed to be in the post-hand pause (~15s window:
#    10s showdown pause + autostart delay; HAND_RESULT_PAUSE_MS=10000)
docker compose up -d backend
```

`GET /api/tables` → `[{ id, seated, humans, handActive, connectedClients }]` is
the deploy gate (`handActive = !!t.hand`; `connectedClients` = live human
sockets). Rules, in order:

- **Never recreate mid-hand while a HUMAN is playing.** A bots-only hand
  (`humans: 0`, even with `seated: 9`) is fine to drop.
- **Safe when** every table has `seated: 0` **or** `handActive: false` (idle, or
  the between-hands gap) — recreate now.
- **Hold a batch** until `connectedClients === 0` (every human disconnected) when
  asked, so a full house of real players isn't disrupted at all.

Always pass `DEPLOY_NOTE="…"` so the boot posts a "🔧 Update: …" line to table
chat. Quick check (prints `SAFE`/`WAIT`):

```bash
docker exec folken-poker-backend node -e "fetch('http://localhost:3000/api/tables').then(r=>r.json()).then(d=>console.log(d.some(t=>t.seated>0&&t.handActive)?'WAIT':'SAFE'))"
```

Frontend-only changes (CSS, JS, HTML, audio assets) don't need a
container recreate — nginx serves them live. Just bump the
`?v=…` cache-bust in `public/index.html` and push.

## Coding principles

When making changes:
1. **No bandaids — fix the root cause.** Multiple patches to the same underlying issue means the design is wrong.
2. **No duplication.** One source of truth per piece of data; one function per piece of logic.
3. **Stable — don't lose data.** Migrations are idempotent. Mid-hand changes preserve in-hand state.
4. **Commit + push every change with a clear message.** Explain *why*, not just *what*.
5. **Defer container recreates to between-hand windows** (see Deploy protocol above). Frontend changes ship instantly via cache-bust; backend rebuilds wait for `hand-complete`.
