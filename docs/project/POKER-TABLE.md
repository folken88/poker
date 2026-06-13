# Poker Table

## Game

Texas Hold'em, blinds 25/50, default stack 5,000 gp. One shared table (`main`).
Humans pick a roster character (or adopt a bot persona — the human supersedes
the AI for the session, keeping that character's chips/gear). Seats persist
through disconnects (reserved); AFK handling and per-turn timers in the topbar.

`Hand.js` runs the hand state machine; `pot.buildSidePots()` produces correct
side pots (payout integrity was audited over 50 hands: 0 mismatches, splits and
multi-side-pot all-ins balanced exactly).

## Bots

- ~47 personalities (see `bot/banter.js CHARACTER_FLAVOR`) with base modes
  (cautious/standard/aggressive), intelligence tiers, and `maybeShiftMode`
  drift. Decision engine in `bot/Bot.js` + `strength.js` (pokersolver), every
  decision logged to `bot-decisions.jsonl` with reasons.
- **Auto-invest**: after each hand, bots buy gear breadth-first (+1 everything
  before +2 anything). They keep a cash cushion: hard floor 5,000 (`RESERVE`),
  comfort ceiling 50,000 — buy-eagerness rises convexly (~5% at 15k, ~20% at
  25k, 100% above 50k). See `Table.js _planBotGearPurchase`.
- Vorkstag impersonates seatmates (`Seat.avatarOverride` + `impersonatedNick`,
  which also steals their 11labs voice).
- Bot rebuys are free (the house); humans borrow from the **First Bank of
  Abadar** (`lobby:resetStack` = +5,000 loan, compounding interest via
  `tickDebtTurn`, pay down with `lobby:payDebt`). Debt clears on Loot Lord reset.

## Banter & voices

LLM-generated table talk (20% probability gates, "interesting moment" hooks,
bust events), spoken via 11labs per-character voices (`character_voices`),
muffled when heard from inside the dungeon. Blind narrator skips voiced lines
(no double-speak) but covers them if synthesis fails.

## Leaderboards & records

- **Both leaderboards (popup top-10 + sidebar Hu/All) rank by POKER NET**
  (won − lost across every logged hand) — not current cash. Server-computed in
  `logger.js` (`_nets`, boot-seeded from hands.jsonl, reset-era aware), exposed
  on every roster row as `pokerNet`/`pokerHands`. Signed display, red when
  underwater, never-played players hidden, cash kept in the tooltip.
- **Hall of Records** (`getRecords()`): biggest pot / single-hand gain & loss /
  bluff (uncontested steal with junk), ugliest showdown winner, longest war —
  per population (all/human/ai), only current-roster players counted.
- **Loot Lord**: +5 in all five gear slots = permanent crown + records entry.

## Meyanda integration points

`Table.js` after `logHand` → `meyanda.onHandLogged` (posts when ≥2 dealt-in
seats were human-driven — `players[].bot === false`, which includes humans
piloting personas). `lobby.js` debt paths → `meyanda.onDebtEvent`.

## Keyboard / accessibility (table)

Blind mode (`blindMode.js`): backtick toggles; spoken state, earcons,
push-to-talk (hold Space) voice commands. Hard refresh on Josh's Mac is
**Cmd+Option+R** (tell him that, not Ctrl+Shift+R).

Keys (on your turn unless noted): **F** fold · **K** check/call · **A** all-in ·
**R** opens the RAISE MENU (then 1 min, 2 half-pot, 3 pot, 4 all-in; Esc cancels) ·
**T** raise-to-pot · **V** custom raise box · **C** your cards · **B** board ·
**P** pot · **M** cash · **N** bet this hand · **1-9** read a seat · **S** stop ·
**?** help mode. **0** toggles CARD READER: then 1/2 = pocket, 4/5/6 = flop,
7 = turn, 8 = river — speaks ONLY the card (slot meanings are taught in help
mode). **Help mode describes every key INCLUDING the bet keys even off-turn**
(they were turn-gated before — Josh bug).

Audio menu is a true click-disclosure (`display:none` when closed → out of the
a11y tree, no hover-open that strands the VO cursor). Hand-rankings panel
auto-collapses when blind mode turns on. The sidebar leaderboard / Hall of
Records render-if-changed (identical re-renders were stranding the VO cursor and
blinding the Item Chooser). While the screen reader is talking, the current AI
character-voice clip is auto-muted (no talk-over), restored when it goes quiet.
