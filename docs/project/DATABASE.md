# Database & Logs

## SQLite (`backend/data/poker.db` via better-sqlite3 — synchronous)

Managed in `persistence/db.js`. Key table: **players**

| Column | Notes |
|---|---|
| `player_id` | lowercase name — the persistence key everywhere |
| `nickname` | display (bots re-synced from `BOT_ROSTER` each boot) |
| `is_bot` | 1 = AI character (humans may still pilot it) |
| `chips` | the single currency (gp) |
| `rebuy_debt`, `debt_turns` | Bank of Abadar loan + compounding clock (humans only) |
| `class`, `weapon` | PF1 class + base weapon key (bots pinned via `BOT_CLASSES` / `BOT_WEAPONS`, re-synced every boot by `seedRoster`) |
| `avatar_id`, `gender`, `bot_mode`, `bot_intelligence` | presentation/AI knobs |
| `ability_scores` | 25-pt-buy array (seeded per class profile) |
| `xp` | dungeon XP → `levelFromXp` (level is NEVER from gear) |
| `crowned` | permanent Loot Lord crown |
| gear | per-slot tiers (weapon/armor/shield/cloak/ring 0–5) via `getGear`/`setGear` |

Boot behavior: `seedRoster()` runs at require time — inserts missing roster
rows, re-syncs every bot's nickname/avatar/mode/intel/gender/class/weapon from
code (code is the source of truth for bot config), prunes stale bots.
Hand history also mirrors into a SQLite table via `insertHand` (UI/admin).

In-memory decoration: `setPokerNets(map)` — `logger.js` hands over its live
net-winnings Map once; `listHumans/listBots/listAll` decorate every row with
`pokerNet`/`pokerHands` for the leaderboards.

## JSONL logs (`backend/logs/`, bind-mounted, append-only)

| File | One row per | Notable fields |
|---|---|---|
| `hands.jsonl` | completed poker hand | `ts, smallBlind, bigBlind, board, players[] {playerId, hole, stackStart, stackEnd, totalIn, folded, allIn, bot}` (**bot:false = human-driven, incl. piloted personas**), `pots[] {amount, eligible}`, `winners[] {playerId, amount, handDesc, cards}`, `events`. `{type:'reset'}` marker rows start a fresh records/nets era. |
| `dungeon.jsonl` | dungeon event | `encounter, room (enemy statlines), action {who, kind, hp, enemiesAlive}, clear {gold, runGold}, loot_check/lootdrop/lootwin, levelup, ally_payout, extract, potion…` — the forensic record for restoring lost gear/gold |
| `bot-decisions.jsonl` | poker bot decision | strength, state, pot, action, reason |
| `conversation.jsonl` | table chat funnel line | banter + human chat + gameplay narration, for banter QA |
| `blind.jsonl` | blind-client telemetry row | everything Josh's narrator spoke + module init info — THE debugging tool for accessibility issues |

Boot-seeded accumulators (in `logger.js`, NOT persisted separately): Hall of
Records (`getRecords()` — biggest pot/gain/loss/bluff, ugliest winner, longest
war; per all/human/ai; roster-gated) and per-player poker nets. Both replay
`hands.jsonl` at startup and honor reset markers; `resetRecords()` writes a
marker (called on Full Reset / Loot Lord).

## Secrets in `backend/data/` (gitignored, bind-mounted, survive rebuilds)

- `.meyanda.env` — `MEYANDA_ENABLED=1`, `MEYANDA_TOKEN=…`, `MEYANDA_CHANNEL=…`
  — **must be uid-1000-owned** (container's `node` user) or it silently fails.
- `.announce-ts` — reboot-announcement dedupe timestamp.
- 11labs key: via container env (compose), never in code or client payloads.
