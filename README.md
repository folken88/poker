# Folken Poker

Multiplayer Texas Hold'em for me and friends. Hosted at <https://poker.folkengames.com>.

One persistent table. Whoever shows up sits down. AI bots fill empty seats and play with a personality (cautious / standard / risky) that drifts between hands. Bots wear the faces of PCs from my long-running Pathfinder campaigns — tokens are copied permanently into the project so the poker game has no runtime dependency on FoundryVTT.

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
│   │   │   ├── Table.js           # seats, current Hand, bot driver, AFK + action timers
│   │   │   ├── Hand.js            # state machine: preflop → flop → turn → river → showdown
│   │   │   ├── Deck.js            # shuffle + deal
│   │   │   ├── Pot.js             # side-pot math
│   │   │   └── actions.js         # action validator (fold/check/call/raise/all-in)
│   │   ├── bot/
│   │   │   ├── Bot.js             # heuristic decision engine, mode tuning, RNG variance
│   │   │   └── strength.js        # Bill Chen preflop + pokersolver rank/10 postflop
│   │   ├── persistence/
│   │   │   ├── db.js              # SQLite, roster + bot roster seeding, chip persistence
│   │   │   ├── schema.sql
│   │   │   └── logger.js          # JSONL hand history + bot-decision logs
│   │   └── sockets/
│   │       ├── lobby.js           # choose player, set avatar, reset, list bots
│   │       └── table.js           # join, action, request-hole, add/remove bot
│   ├── data/                      # SQLite file (mounted volume; gitignored)
│   ├── logs/                      # JSONL append-only logs (gitignored)
│   ├── Dockerfile
│   └── package.json
├── public/                        # static UI (served by nginx)
│   ├── index.html
│   ├── css/table.css
│   ├── js/{client,cards,avatars}.js
│   └── assets/
│       ├── avatars/               # 12 preset SVG avatars for humans
│       └── characters/            # PC tokens from the vault (gitignored; manifest committed)
├── nginx/nginx.conf
├── scripts/
│   └── import-vault-tokens.js     # one-shot importer (see below)
├── docker-compose.yml
└── README.md
```

## Architecture

- All authoritative game state lives on the server. Clients send action *intents* (fold, call, raise N), never state.
- Each player's hole cards are emitted only to that player's socket — never broadcast. Reconnects re-request them via `table:requestHole`.
- One Socket.IO room per table. Spectators get public events but never private hole-card events.
- Identity: per-tab sessionStorage cookie + chosen nickname from a fixed roster. Chips persist per player_id (lowercased name). No auth — anyone clicking "Fred" is Fred for that tab.

## Game features

- 9-seat ring on a flatter ellipse. Programmatic SVG cards, dark felt-green theme.
- Persistent table — newcomers wait for the current hand to end, then are dealt in.
- **Seats survive disconnects**. Your chips + position are reserved; refresh and you're back where you sat.
- **AFK detection** — players who haven't acted are skipped at deal time and don't pay blinds.
- **45 s action timer** for humans. Time out = auto-fold (or auto-check when free).
- **Side pots** when someone is all-in. Showdown awards each pot independently.
- **Reset modal** — cancel current hand (refund bets) or full reset (everyone back to 5,000).

## Bots

Six AI seats are seeded into the DB and available via the **+ Bot** button. They play as named PCs from my home campaigns:

| Bot                     | Mode      | Race / Class                    |
|-------------------------|-----------|---------------------------------|
| Dinvaya                 | cautious  | Aasimar Cleric                  |
| Vaughan                 | cautious  | Half-Elf Magus                  |
| Storgrim Thunderbeard   | standard  | Dwarf Fighter                   |
| Kate Blackwood          | standard  | Skinwalker Magus                |
| Kovira                  | risky     | Tiefling Arcane Trickster       |
| Elfrip                  | risky     | Goblin Oracle                   |

Decision engine in `backend/src/bot/`:

- **Preflop**: Bill Chen formula → adjusted score → fold / call / raise thresholds tuned per mode.
- **Postflop**: `pokersolver` rank normalized to 0–1, with bonuses for flush + open-ended-straight draws.
- **Mode tuning** boosts strength estimates, raise/bluff probability, and sizing. Modes drift between hands with low probability so a "cautious" bot occasionally gets bold.
- Every decision is appended to `backend/logs/bot-decisions.jsonl` for later analysis.

## Character art import (one-time)

The bot avatars and any future PC-token assets live in `public/assets/characters/`. They are **not** drawn live from FoundryVTT — they were copied once via:

```bash
node scripts/import-vault-tokens.js
```

The script:
1. Walks Cassbot's Obsidian vault (`Documents/cass_discord_bot/obsidian_cass/cassvault/Characters/`).
2. Parses YAML frontmatter for PCs (`tags: ["pc"]`).
3. Indexes the local Foundry character art library (`F:/foundryvttstorage/foundryvtt-media/Art - Characters/`).
4. Scores filename matches against each PC's name (preferring `token_*` prefix, webp, known campaign folders).
5. Copies the winner permanently to `public/assets/characters/<slug>.webp` and writes a `manifest.json`.

The `.webp` files are gitignored (out of caution about redistributing module art); `manifest.json` is committed. Anyone with the same vault + Foundry library can re-run the script to regenerate them.

## Logs

- `backend/logs/hands.jsonl` — one line per completed hand: board, players, actions, winners.
- `backend/logs/bot-decisions.jsonl` — one line per bot decision: street, hand strength, mode, chosen action, reason.

Both are append-only and gitignored.
