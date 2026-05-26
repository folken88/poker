# Folken Poker

Multiplayer Texas Hold'em for me and friends. Hosted at <https://poker.folkengames.com>.

One persistent table. Whoever shows up sits down. A roster of named **AI bots** (27 of them, each with a personality + intelligence tier) fills empty seats and plays. Bots wear the faces of PCs and villains from my long-running Pathfinder campaigns — tokens are copied permanently into the project so the poker game has no runtime dependency on FoundryVTT.

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
│   │   │   │                      #   wealth-aware ctx, per-opponent bluff memory
│   │   │   └── strength.js        # Bill Chen preflop + pokersolver rank/10 postflop
│   │   ├── persistence/
│   │   │   ├── db.js              # SQLite, roster + bot roster seeding, chip + gear
│   │   │   │                      #   persistence, one-shot migrations (legacy swords,
│   │   │   │                      #   amulet removal)
│   │   │   ├── schema.sql
│   │   │   └── logger.js          # JSONL hand history + bot-decision logs
│   │   └── sockets/
│   │       ├── lobby.js           # choose player, set avatar, gear buy/sell, reset, debt
│   │       └── table.js           # join, action, request-hole, add/pick/remove bot,
│   │                              #   sit-out / rejoin
│   ├── data/                      # SQLite file (mounted volume; gitignored)
│   ├── logs/                      # JSONL append-only logs (gitignored)
│   ├── Dockerfile
│   └── package.json
├── public/                        # static UI (served by nginx)
│   ├── index.html
│   ├── css/table.css
│   ├── js/{client,cards,avatars}.js
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
- **120-second action timer** for humans. Time out = auto-fold (or auto-check when free). Bots have their own mode-flavored thinking delays (risky 1d4s, standard 1d10s, cautious 1d15s).
- **Side pots** when someone is all-in. Showdown awards each pot independently.
- **Fold-win reveal** — even when everyone else folds, the winner's hole cards flip face-up so opponents can see if it was a bluff. Description auto-tags obvious bluffs ("Ten-Two off — total bluff").
- **Sit out / Rejoin** — keep your seat but skip deals until you're ready.
- **Reset modal** — cancel current hand (refund bets) or full reset (everyone back to 5,000).
- **Per-action chat log** — one line per turn (fold/check/call/raise/all-in) with chip amounts, plus winner announcements with revealed hand descriptions.

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

The 27-bot roster lives in `backend/src/persistence/db.js` (`BOT_ROSTER`). Each bot has two orthogonal traits:

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
- **Deliberate bluffs** — non-low intel bots gated on cheap-bluff conditions; risky 1.8× rate, standard 1.0×, cautious 0.3×.
- **Wealth-aware risk** — bots see opponents' chips + gear value. Richer bots size up; poorer tighten. Rich aggressors discounted (presumed bluff); poor aggressors respected. Weighted by intel.
- **Bluff memory** — per-opponent samples of revealed bluffs vs value bets. After every showdown / fold-win reveal, every bot at the table updates its memory of who committed ≥4 BB with what strength. At decision time, the aggressor's smoothed bluff ratio shifts the fold threshold up to ±0.12 (high intel uses fully; low intel barely uses it).
- **Mode drift** — at end of hand, 18% chance to shift mode; tends to drift back toward baseMode.
- **Bot gear auto-invest** — at end of every hand, bots spend excess chips (keeping ≥5,000 reserve) breadth-first: every slot at +1 before any +2, every slot at +2 before any +3, etc. Cheapest-affordable-first.

Every decision is appended to `backend/logs/bot-decisions.jsonl` for later analysis.

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

A subset of human-roster names (Tobis, Timmy, Sydness, BRION, Zachariah, Harry, Banana, Fred, Leesa, etc.) is treated as **human-only**. The `+ Bot` button and the bot picker modal both filter on `is_bot = 1`, so AI never plays these names.

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

- **Left** — your gear bank + buy/upgrade/hock buttons. Reads from the persisted roster record so it stays correct even between hands or while sat out.
- **Right** — live wealth leaderboard (chips + gear value). Updates on every roster event.
- **Help / Hand rankings / Tips** — in the `?` modal in the topbar (not the perimeter).

## Mobile (≤720px)

- Side panels hidden; help modal accessible via `?` button.
- Seats collapse to **token + name only** (64×96 px). Chips, gear, hole cards, timer (on non-actors), and AFK/sit-out tags are suppressed. The acting seat still shows its countdown.
- Action panel becomes a **fixed bottom toolbar**: Fold / Call / Raise / All-in in one wide row, raise input + preset chips. Drag handle, presets, bank/leaderboard toggles all hidden — they live in the perimeter on desktop, which is sufficient.
- A "my hand" strip in the toolbar shows your hole cards + chips + current bet.

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

## Coding principles

When making changes:
1. **No bandaids — fix the root cause.** Multiple patches to the same underlying issue means the design is wrong.
2. **No duplication.** One source of truth per piece of data; one function per piece of logic.
3. **Stable — don't lose data.** Migrations are idempotent. Mid-hand changes preserve in-hand state.
4. **Commit + push every change with a clear message.** Explain *why*, not just *what*.
