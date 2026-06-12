# Architecture

## Containers (per stack — prod and testbed are twin stacks)

```
poker/                          # /mnt/fast/apps/stacks/poker (PROD, IS the git repo)
├── docker-compose.yml
├── backend/                    # node backend — BAKED into the image (build: ./backend)
│   ├── Dockerfile              # exec-form CMD ["node","src/server.js"] → node is PID 1
│   ├── src/ …                  # all server code (see module map below)
│   ├── data/   (bind mount → /app/data)   # SQLite DB + secrets — GITIGNORED
│   └── logs/   (bind mount → /app/logs)   # append-only JSONL logs
├── public/                     # static client — bind-mounted RO into nginx (LIVE)
└── nginx/nginx.conf            # serves public/ on :80 → host 32086 (prod) / 32096 (test)
```

- `folken-poker-backend` — node, internal :3000, reached only via nginx proxy.
- `folken-poker-web` — nginx:alpine, publishes 32086 (prod) / 32096 (testbed).
- Compose project names: `poker` (prod) and `poker-test`.
- Testbed lives at `/mnt/fast/apps/stacks/poker-test` — same layout, NOT a git
  repo, separate DB/logs (fresh state, all bots at 5k).

## Backend module map (`backend/src/`)

| Module | Role |
|---|---|
| `server.js` | Express + Socket.IO bootstrap; `/api/tables` (the deploy gate), `/api/health`, localhost-only `/api/admin/announce` (Prime reboot line, 11labs, 3-min dedupe); SIGTERM handler banks active dungeon runs before exit; starts Meyanda |
| `sockets/lobby.js` | `lobby:choosePlayer` (humans may adopt bot personas), roster, class/weapon/gender/avatar pickers, `pf1meta`, re-buy loan + `payDebt` (both post Meyanda debt lines), gear buy/sell |
| `sockets/table.js` | seat/stand, `table:addBot` / `fillBots`, actions in the hand |
| `sockets/dungeon.js` | `dungeon:enter/action/leave/cancel`, recruit (fee = 50g + 10g×level), recruitRandom, reconnect grace |
| `game/Table.js` | poker table: seats, hand loop, bot auto-invest in gear (comfort band 5k–50k), Loot Lord check, hand logging + Meyanda hand lines, chatter |
| `game/Hand.js` | Hold'em hand state machine, pots/side-pots (`pot.buildSidePots`) |
| `game/Dungeon.js` | THE big one (~5k lines): the whole PF1 crawler — see DUNGEON.md |
| `game/character.js` | `deriveCharacter` (HP/BAB/saves from class+level+ability scores), `attackProfile` (STR/DEX/finesse/2h/offhand math) |
| `game/combat.js` | `weaponOf` (staple+custom lookup, masterwork/+N normalization), shared dice/sound helpers |
| `pf1data/abilities.js` | every class KIT (at-will + ability list), SPELL dictionary, cantrips, metamagic wrappers, `SELECTABLE_CLASSES`, `CASTER_CLASSES`/`SPONTANEOUS_CLASSES`, slot tables |
| `pf1data/classes.js` | PF1 base classes (HD/BAB/saves), weapon `PROFICIENCY` map (uniform — no AI exemption), `weaponProficient` |
| `pf1data/staples.js` | weapon list + `CUSTOM_WEAPONS` (named signature weapons: Rovadra, Curator, Redeemer, the backup `lightcrossbow`…) |
| `pf1data/abilityScores.js` | 25-point-buy allocator, mods |
| `pf1data/characterProfiles.js` | per-class stat seeds (SAD/MAD, gish profiles) |
| `pf1data/xp.js` | `levelFromXp`, CR→XP tables |
| `persistence/db.js` | better-sqlite3, schema + seed (`seedRoster` re-syncs bots every boot from `BOT_ROSTER`/`BOT_CLASSES`/`BOT_WEAPONS`), `setPokerNets` decoration |
| `persistence/logger.js` | JSONL writers (hands/bot-decisions/conversation/dungeon/blind), Hall of Records + poker-net accumulators (boot-seeded from hands.jsonl, reset-era markers) |
| `bot/Bot.js`, `bot/strength.js` | poker decision engine + hand-strength eval (pokersolver) |
| `bot/banter.js` | LLM chatter: `CHARACTER_FLAVOR` personalities, victory lines, voice gating |
| `discord/meyanda.js` | family Discord herald — see below |
| `util/…` | flavor lines, number-words, linePool |

## Client (`public/`)

- `js/client.js` — the whole SPA: screens (roster→confirm→table→dungeon),
  socket handlers, seat/table render, dungeon UI (recruit panel incl. "↻ Last
  party" via localStorage, spellbook, loot), leaderboards (rank by poker NET),
  audio players (dungeon sounds fade 4s→5s), bot picker (incl. "↻ Last party").
- `js/blindMode.js` — blind support: TTS narration (speaks ALL fresh log lines,
  8-line cap), keyboard layer (numbers = actions, 0 = door, B = bail, `.` =
  cancel w/ confirm, E = enemy inspector incl. DR, help mode `?` describes keys
  without firing), push-to-talk voice commands, telemetry → `blind.jsonl`.
- `js/cards.js`, `css/table.css`, `index.html` (cache-busted script tags).

## Real-time flow

Client ⇄ Socket.IO: `lobby:*`, `table:*`, `dungeon:*` events; broadcasts:
`roster`, `table:state`, `table:chat`, `dungeon:state` (includes per-member
`kit` snapshot from `_kitState`, enemy conditions/wards, log lines with `t`
timestamps + optional `sound`). The dungeon and table cross-talk: dungeon
combat echoes muffled sounds to the table; member exits post table chat.

## Meyanda (Discord)

Write-only REST bot (no gateway). Config in `backend/data/.meyanda.env`
(`MEYANDA_ENABLED/TOKEN/CHANNEL`, uid-1000-owned; missing = silent no-op so
testbed runs dark). Posts to the family server poker-log channel
(1513251796087476365): one line per hand with ≥2 human-driven seats, human
debt borrows/repayments, and a daily 11:00 America/Chicago report (day stats,
or archive/historical stats on quiet days, plus standings, Hall of Records,
dungeon totals).
