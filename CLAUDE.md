# Folken Poker — AI session guide (the living-docs mandate)

PF1-flavored poker + dungeon crawler. Node backend (`backend/src`, Docker),
vanilla-JS client (`public/js`), SQLite state (`backend/data`). Blind-first
accessibility is a core requirement (Josh, VoiceOver tester).

## The map (read before exploring)
| Where | What |
|---|---|
| `backend/src/game/Dungeon.js` | dungeon combat core (being split into `game/dungeon/*` mixins — see docs) |
| `backend/src/game/combat.js` | shared dice/sound/AC helpers (`SND` sound pools) |
| `backend/src/pf1data/` | rules DATA: kits (`kits.generated.js` — generated, see below), monsters, races, classes, domains, loadouts, xp |
| `backend/src/persistence/db.js` | poker.db (players/gear/xp/loadouts/domains) |
| `backend/src/sockets/` | socket routes (`dungeon:*`, lobby, poker) |
| `backend/src/version.js` | THE app version + one-line changelog |
| `public/js/client.js` | whole client (split deferred); blind keys live here |
| `public/js/blindMode.js` | TTS engine: priorities, sections, ducking |
| `docs/project/` | design docs (domains, loadouts, conditions, refactor plan) |

## Mandates (every change)
1. **Version**: bump `backend/src/version.js` — MINOR per feature batch, PATCH
   per fix batch — and add its one-line changelog entry. The topbar/API read it.
2. **Headers**: every source file opens with a compact self-describing header
   (purpose, key exports, depends-on). If your change alters a file's behavior
   or shape, update its header — one line, no essays. New files are born
   compliant.
3. **Kits**: `kits.generated.js` is GENERATED (content DB → `gen-kits.js`).
   Edit the DB first when possible; if you hand-edit, keep `abilities.js` in
   lockstep and re-run the reconcile pipeline (extract-kits2 → load-kits →
   regen-diff must be identical). Never edit the frozen KITS fallback block.
4. **Deploy**: testbed (`poker-test`, :32096) first, then prod (:32086) gated
   on `/api/tables` showing no humans/handActive/dungeonActive — a backend
   recreate KICKS live dungeon players. Statics (`public/`) are safe any time.
   Prime announces before prod recreates. Busy prod → systemd watcher pattern
   (one at a time; replace wholesale, never stack payloads).
5. **Builds are CACHED**: `docker compose build backend` (NO `--no-cache` —
   the Dockerfile is layered; cached = ~1–20s vs minutes). Escape hatch: use
   `--no-cache` only if the Dockerfile/package.json layer itself misbehaves.
6. **Blind keys**: `S` is the sacred global stop-talking key. Before binding
   any key, grep ALL keydown handlers (global + poker + dungeon). AoE combat
   narration is COUNTS-ONLY ("3 hit, 1 saved, 2 spell-resisted").
7. **PF1 first**: rules follow PF1 RAW unless a documented homerule exists
   (see `docs/project/PF1-CONDITIONS.md`). Enemies can do everything heroes
   can (parity mandate). Per-room = the game's "per day".
8. **PF1CORE boundary** (docs/project/PF1CORE-PLAN.md): a future PGM app
   shares the rules engine. **`src/pf1core/index.js` is THE door** — 13
   concept namespaces (abilities/feats/classes/races/domains/monsters/
   weapons/xp/abilityScores/loadouts/profiles/character/combat); NEW code
   imports rules through it. Everything behind it is pure — NEVER imports
   persistence/sockets/bot (the test suite's purity gate enforces this).
   Rules math goes core-side; loops/narration/economy stay app-side.
   Expedient rules code in Dungeon.js gets a `// PF1CORE:` breadcrumb.

## Verification habit
Backend logic ships with in-container unit tests (`docker cp test.js
folken-poker-test-backend:/tmp && docker exec ... node /tmp/test.js`) —
prototype-call the method under test with a fake `this`. Run before prod.
