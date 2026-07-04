# Notes for coding AIs (Claude Code, Cursor, Codex)

You are working on a LIVE family game. People (including a blind player, Josh)
play it daily, sometimes around the clock. The hard rules below exist because
each one was learned the painful way.

## Hard rules

1. **NEVER restart/rebuild the prod backend while a dungeon run is active or a
   human is seated.** A backend recreate wipes in-memory state (runs, hands).
   Gate on `GET /api/tables`: deploy only when every table shows
   `humans:0 AND handActive:false AND dungeonActive:false`. Do NOT use
   `dungeonHumans` as the gate (it dips to 0 transiently mid-run). A SIGTERM
   handler now banks dungeon gold on shutdown as a backstop — but interrupting
   a run still costs the party their depth/progress. Wait for the whole run.
2. **Testbed first.** Deploy every change to the testbed stack (`:32096`),
   verify inside the container, then promote to prod behind the gate.
3. **Backend code is BAKED into the Docker image.** Builds are CACHED and fast
   (1–20s): `docker compose -p <proj> build backend` then
   `up -d --force-recreate backend` — the `--force-recreate` is the part that
   matters (the old "stale layer" scare was a missing recreate, not the cache).
   Prove freshness via the `version.js` bump + `curl /api/version`, or grep a
   unique new string inside the running container. `--no-cache` is the escape
   hatch only if the Dockerfile/package layer itself misbehaves.
4. **`public/` is a live read-only bind mount** into the nginx container —
   client JS/CSS/HTML changes are live instantly, no rebuild, no gate. Bump the
   cache-buster query (`client.js?v=YYYYMMDD-tag`) in `public/index.html`.
5. **Secrets never reach git.** `backend/data/` is gitignored and bind-mounted;
   secrets live there (`.meyanda.env` = Discord token). Env files read by the
   container must be owned by **uid 1000** (the container's `node` user) or the
   read silently fails. The 11labs key, git credentials and the sudo password
   must never appear in client payloads, logs, or commits.
6. **One gate-watcher at a time.** If a deploy must wait for the gate, run ONE
   watcher loop; never arm a second for the same files (double-fires caused a
   duplicated reboot announcement once and a race that mislabeled a commit).
7. **Reboot announcement**: before every prod backend recreate, POST
   `{"text":"[excited] I'M REBOOTING TO APPLY UPDATES, FUCKERS!"}` to the
   localhost-only `/api/admin/announce` from inside the container, wait ~9s,
   then recreate. The endpoint voices it via 11labs (Prime) and dedupes with a
   3-minute cooldown persisted in `backend/data/.announce-ts`.

## The .LIVE.js workflow

Local source of truth: `C:\Users\Tobias Merriman\Documents\_truenas_build\_deploy\`.
Edit locally, `node --check`, scp to the server staging dir
(`/home/truenas_admin/_deploy_tmp/`), then `sudo cp` into the stack tree(s).

| Local file | Server path (under `backend/src/` unless noted) |
|---|---|
| `Dungeon.LIVE.js` | `game/Dungeon.js` |
| `Table.LIVE.js` | `game/Table.js` |
| `abilities.js` | `pf1data/abilities.js` |
| `classes.LIVE.js` | `pf1data/classes.js` |
| `staples.LIVE.js` | `pf1data/staples.js` |
| `db.LIVE.js` | `persistence/db.js` |
| `logger.LIVE.js` | `persistence/logger.js` |
| `server.LIVE.js` | `server.js` |
| `sockets-dungeon.LIVE.js` | `sockets/dungeon.js` |
| `sockets-lobby.LIVE.js` | `sockets/lobby.js` |
| `sockets-table.LIVE.js` | `sockets/table.js` |
| `banter.LIVE.js` | `bot/banter.js` |
| `meyanda.LIVE.js` | `discord/meyanda.js` |
| `character.js` | `game/character.js` |
| `characterProfiles.js` | `pf1data/characterProfiles.js` |
| `combat.LIVE.js` | `game/combat.js` |
| `client.js` | `public/js/client.js` (static — instant) |
| `blindMode.LIVE.js` | `public/js/blindMode.js` (static — instant) |
| `index.prod.html` | `public/index.html` (static — instant) |
| `table.css` | `public/css/table.css` (static — instant) |

Windows scp is case-insensitive: if two server files differ only by case, scp
under distinct temp names.

## Design conventions

- **PF1 fidelity is the product.** When adding mechanics, look up the
  Pathfinder 1e rule and implement it honestly; where the game lacks a grid,
  use the established spatial shortcuts (see DUNGEON.md "Action economy").
  Tobias will quote RAW at you (e.g. divine Hold Person is 2nd, arcane is 3rd).
- **Tunables live where they're used**, commented with the why (e.g. the bot
  gear "comfort ceiling", recruit fee formula, boss advancement table).
- **Per-character flavor** uses existing hooks: `char:`/`notChar:` tags on
  abilities (`_charAllows`), `BOT_WEAPONS` named-weapon map, `CUSTOM_WEAPONS`
  staples, `MAGUS_SPELLSTRIKE_SFX`, oracle mysteries, spiritual-weapon deity map.
- **Narration is part of accessibility.** Every combat note is read aloud to
  blind players. Keep lines speakable; aggregate multi-swing turns into one
  line; counts not lists for 3+ target save spells; always include the
  `−N DR` soak tag in hit lines.
- **Commit style**: one logical change per commit, message explains the WHY and
  the mechanics, ends with `Co-Authored-By: Claude <model> <noreply@anthropic.com>`.
  Commits happen ON THE SERVER repo (the prod checkout) and push to GitHub with
  the credential-grafted URL (see DEPLOY-OPS.md).

## Known sharp edges

- `sudo -S` prompt has no trailing newline — the first output line lands on the
  prompt line. Echo a `PAD` line first or your greps eat real output.
- `nohup`/`setsid`/`flock` fail with ENOSYS on the NAS host shell. To run a
  long gate-watcher, run it in the FOREGROUND over ssh and keep the ssh session
  alive from the client side (`run_in_background` on the local side).
- The seeded-humans boot log line counts only table seats — never use it to
  decide if a rebuild is safe; only `/api/tables` is authoritative.
- `hands.jsonl` grows forever; logger seeds Hall-of-Records and poker-net
  accumulators from it at boot, honoring `{type:'reset'}` era markers.
- Dungeon `slot` action payloads index into the FULL kit ability array —
  filters (level/char gating) must never renumber slots.
- **An uncaught throw anywhere crashes the whole process** (one Node thread):
  docker auto-restarts and any in-memory dungeon run is lost. The SIGTERM payout
  only covers graceful shutdown, so `server.js` also banks live runs on
  `uncaughtException`/`unhandledRejection`. Guard async timer callbacks against
  state that may have been nulled since they were scheduled (the loot-roll timer
  re-read `this.lootRoll` mid-loop and crashed). When a player reports being
  "kicked + robbed", check the backend logs for a crash FIRST — a piloted
  persona already counts as human (`addMember` isBot=false; `/api/tables`
  `dungeonHumans` uses `!m.isBot`), so "persona not detected" is usually a
  red herring.
- **Card portraits** (`public/portraits/` + `manifest.json`): paired from each
  token's Foundry `token_*` sibling by content-hash (`tools/pair_portraits.sh`).
  Unpaired tokens (renamed/edited, or token-only art) keep their plain card bg;
  the tokens manifest's `sourceFile` records the original Foundry path. Regenerate
  the manifest after adding portraits or the client won't use them.
