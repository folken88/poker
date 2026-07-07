# PF1CORE — one rules engine, two apps

Status: **DIRECTION LOCKED (Tobias, 2026-07-04).** Companion to
REFACTOR-AND-RACES-PLAN.md; constrains every restructure seam from here on.

## The mandate
A future **Personal GM** app (`pgm.folkengames.com`) will take a character from
level 1 through story-mode PF1 play — story content, skill checks, and combat —
using the SAME simulation code as the poker app's dungeon. It will NOT touch the
poker app or its character DB. Therefore the PF1 rules engine must live in one
shared core: **fix Dispel Magic once, both apps get it.**

```
            ┌────────────────────┐        ┌─────────────────────┐
            │  POKER app         │        │  PGM app (future)   │
            │  dungeon loop,     │        │  story mode, skill  │
            │  loot/gold↔bankroll│        │  checks, campaign   │
            │  sockets, TTS,     │        │  progression, its   │
            │  poker.db chars    │        │  OWN character db   │
            └─────────┬──────────┘        └──────────┬──────────┘
                      └──────────┬───────────────────┘
                          ┌──────▼──────┐
                          │   PF1CORE   │  pure rules: no sockets,
                          │             │  no app DB, no narration
                          └─────────────┘
```

## What belongs in pf1core (the test: "would PGM need this unchanged?")
- **Rules DATA** — today's `pf1data/*`: spells/kits (+ the content DB pipeline),
  classes, races, domains, monsters, weapons, xp, abilityScores. Already pure.
- **Derivation** — `game/character.js` (deriveCharacter, attackProfile). Pure.
- **Resolution math** — dice, spell DCs, saves, SR checks, attack/AC math,
  condition semantics (what dispel may clear, what stacks), metamagic scaling.
  Today much of this sits inside Dungeon.js methods interleaved with narration.

## What stays in the APP layer (poker's, and later PGM's own)
Turn/room loops, encounter spawning, narration/`_note` text, TTS/blind mode,
sockets, gold/loot economy, the character DB, banter, watchers/deploy glue.

## How the current work flows into this
- `pf1data/` + `character.js` + `combat.js` are **de facto pf1core already** —
  treat them as such NOW: no `db`/socket/poker imports may creep in.
- The dungeon mixins (loot, serialize, enemyAI, abilities, and the 2026-07-07
  heroAI + summons seams) are **app-layer** organization — correct and
  unaffected (turn loops, bot decision-making, summon spawning and narration all
  stay app-side). But as seams 3–4 extract, any PURE
  rules helper they carry (SR check math, DC formulas, save math, dispel
  eligibility) should be pulled toward combat.js/pf1data rather than buried in
  a mixin, so the later physical move is file renames, not surgery.
- **Consolidation phase (after seam 4):** move the pure set into
  `backend/src/pf1core/` with a single `index.js` export surface; the dungeon
  imports only through it. From then on pf1core is the shared package PGM
  consumes (copy, submodule, or npm-local — decide when PGM starts).
- Content DB (`dungeon-content.db` + gen-kits pipeline) rides with pf1core —
  it IS the rules-data build system (see dungeon-content-db notes).

## Rules of thumb for every future change
1. Rules math or rules data → pf1core files, pure, unit-testable in isolation.
2. Who to target / what to say / when to act (AI + narration) → app layer.
3. A pf1core file must never require persistence/, sockets/, or read poker.db.
4. When a rules fix lands inside Dungeon.js (expedience), leave a `// PF1CORE:`
   breadcrumb so the consolidation sweep collects it.
