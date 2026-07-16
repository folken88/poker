# Folken Poker — Project Documentation

A family Texas Hold'em poker game fused with a PF1 (Pathfinder 1e) co-op dungeon
crawler, self-hosted on Tobias's TrueNAS box. ~45 AI characters with full
personalities, 11labs voices, an LLM banter system, blind-accessibility support
(built for Josh), and a Discord herald (Meyanda) that reports to the family server.

**This folder is the orientation pack for any coding AI (Claude Code, Cursor,
Codex) working on the project.** Read AI-NOTES.md first if you're an AI.

## Credits

- **Tobias Merriman** — creator & designer: the game, the art, the house rules, and the
  Pathfinder campaigns every character walked out of.
- **Josh Morrison** — co-designer & quality assurance tester. The play-by-ear layer —
  spoken menus, stable hotkeys, honest combat reports, the whole blind-accessibility
  model — was designed with and proven by him, one report at a time.
- **Claude Code (Anthropic)** — engineering.


## Documents in this folder

| File | What it covers |
|---|---|
| [AI-NOTES.md](AI-NOTES.md) | **Start here (AIs):** conventions, gotchas, the `.LIVE.js` workflow, hard rules |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System layout: containers, modules, data flow |
| [POKER-TABLE.md](POKER-TABLE.md) | Hold'em engine, seats, bots, banter, leaderboards |
| [DUNGEON.md](DUNGEON.md) | The PF1 crawler: combat math, classes/kits, monsters, AI |
| [DATABASE.md](DATABASE.md) | SQLite schema + the append-only JSONL logs |
| [DEPLOY-OPS.md](DEPLOY-OPS.md) | Server access, testbed vs prod, the deploy gate, secrets |

## Quick facts

- **Prod URL**: `https://poker.folkengames.com` / LAN `http://192.168.1.200:32086`
- **Testbed**: `http://192.168.1.200:32096` (separate stack, play-test here first)
- **Stack**: Node.js + Express + Socket.IO + better-sqlite3 backend; vanilla-JS
  single-page client; nginx serving `public/`; Docker Compose (managed via
  Dockge) on TrueNAS SCALE at `192.168.1.200`.
- **Repo**: `https://github.com/folken88/poker.git`, branch `main`. The PROD
  checkout on the NAS **is** the git repo (deploys = commits to main).
- **Local working copies** live in
  `C:\Users\Tobias Merriman\Documents\_truenas_build\_deploy\` as `*.LIVE.js`
  files (see AI-NOTES.md for the local→server mapping).
- **Money model**: chips = gold = gp, one currency everywhere. Poker winnings,
  dungeon hauls, gear purchases, and Bank-of-Abadar loans all share it.
- **Win condition**: "Loot Lord" — first to own +5 gear in every slot gets a
  permanent crown.

## The cast (selected)

~30 human roster slots (family members: Tobis, Josh, Fred, Gramm, Mandore,
Timmay, BRION…) and ~47 AI characters drawn from the family's Pathfinder
campaigns (Carrion Crown, Iron Gods, Hell's Rebels, Skull & Shackles):
Kate Blackwood (magus, werewolf clan head), Auren Vrood (necromancer),
Dinvaya & Ulfred (clerics of Brigh), Meyanda (android cleric — also the
Discord bot), Gabriel (Hell's Rebels paladin, wields Redeemer), Rhyarca
(Besmara oracle, Trickery mystery), Elfrip (Flame oracle), Casandalee (Time
oracle), Vorkstag (skinwalker who wears tablemates' faces), Crisp (a
deinonychus), and villains for the dungeon's deep rooms (Zernibeth, Abrogail
Thrune, Barzillai, vampire court, devils, dragons).

Humans can **pilot any AI persona** at the table and in the dungeon
(`lobby:choosePlayer` — the human supersedes the AI for the session).
