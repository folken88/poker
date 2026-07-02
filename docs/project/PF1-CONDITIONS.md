# PF1 Conditions — Canonical Rules vs. Engine Behavior

**Purpose:** the single source of truth for *which actions and powers a combatant may take
under each status condition, per Pathfinder 1e* — and how the Folken Poker dungeon engine
(`backend/src/game/Dungeon.js`) currently models it. Keep this ACCURATE and in sync whenever
condition handling changes. (Started 2026-07-01 at Tobias's request: "keep accurate track of
which powers and actions can be taken while grappled, prone, etc.")

## Engine abstraction — read this first
Our combat is **positionless and gridless**. So the PF1 clauses about *movement* (“can’t
move”, “half speed”, “must flee along a random path”, “5-ft step”, provoking by standing)
mostly **don’t map** — there’s no board to move on. What DOES map, and what this doc tracks:

- **(A) Turn economy** — does the creature act this turn? `full` (move+standard, incl. full
  attack) / `one action` (a single attack OR cast, no iteratives) / `skip` (loses the turn).
- **(B) Attack** — may it attack, and at what to-hit / damage modifier?
- **(C) Cast** — may it cast, and does a concentration check apply?
- **(D) Defense** — AC / save / Dex-denial modifiers as a *target*.
- **(E) Behavior** — AI overrides (won’t attack party, must flee, etc.).

“Per day” = “per room” everywhere in this game (the established day = one room).

---

## Canonical table — modeled conditions

Legend: ✓ faithful · ⚠ partial / abstracted · ✗ conflicts with RAW (see Discrepancies).

| Condition | PF1 RAW (adapted to A–E) | Engine today | Verdict |
|---|---|---|---|
| **Paralyzed** (`paralyzed`) | A: **skip** (mental actions only). B: no attack. C: no cast. D: Dex 0 → helpless, melee +4, denied Dex. | Skips turn (hero+enemy); target −4 AC; sneak-eligible. | ✓ |
| **Held** (Hold Person = `paralyzed` + `heldDC`) | As paralyzed, but a **new Will save each round** ends it. | Re-saves each turn, costs the turn either way; ends on save. | ✓ |
| **Stunned** (`stunned`) | A: **skip**; drops item. B/C: none. D: −2 AC, denied Dex. | Skips turn (hero+enemy); **−2 AC** as target. | ✓ |
| **Staggered / Slowed** (`slowed`) | A: **one action** (move OR standard, no full attack). Slow spell also: −1 atk, −1 AC, −1 Reflex, half speed. | **Enemies** & **heroes**: one attack only (no full-attack), −1 to hit, −1 AC. (−1 Reflex not applied.) | ✓ (−1 Reflex deferred) |
| **Sickened** (`sickened`) | A: **full**, no turn loss. B: −2 atk & dmg. C: cast normally. D: **no AC penalty**. Also −2 saves/skills. | −2 atk/dmg **and −2 all saves**, no turn loss, **no AC penalty** — heroes AND enemies. | ✓ |
| **Nauseated** (`nauseated`) | A: **one MOVE action only** (no standard → can’t attack/cast → effectively skip here). | **Modeled**: skips the turn (hero+enemy); set by save-or-nauseate (Stinking Cloud); clears between rooms/dispel; in `ccd()`. | ✓ |
| **Blinded** (`blinded`) | B: −? (50% miss / can’t use vision attacks) → abstract as to-hit penalty. C: no vision-spells. D: −2 AC, lose Dex. | Attacker −4 to hit; target −2 AC, sneak-eligible. | ✓ (reasonable abstraction) |
| **Grappled** (`grappled`) | A: **full**, but no move; no AoO; can’t use 2-handed weapon. B: −2 atk & CMB (except grapple). C: **concentration DC 10 + grappler CMB + spell level** or lose it (no somatic restriction — that’s *pinned*). D: −4 Dex → −2 AC, denied Dex vs some. | Heroes act w/ penalties (no turn loss); −2 to hit; +2 AC penalty (easier to hit); **concentration check on cast (slot/pool), fail = lost, slot spent**; Inquisitor Liberation exempt. Enemies: lose turn escaping. | ✓ (2-handed / AoO nuance unmodeled) |
| **Pinned** | Like grappled but: **denied Dex**, extra −4 AC, and **can’t cast somatic/material spells at all**. | **Not modeled** (grapple never escalates to pin). | — (future) |
| **Prone** (`prone`) | B: **−4 to the prone creature’s own melee** attacks; can’t use ranged except crossbow. D: **−4 AC vs melee, +4 AC vs RANGED.** Stand = move action. | **−4 AC vs melee, +4 AC vs ranged** (ranged-aware `_enemyAC`); stand = move action. (Prone attacker’s own −4 melee still unmodeled.) | ✓ (self-attacker penalty deferred) |
| **Entangled** | B: −2 atk. C: **concentration DC 15 + spell level.** D: −4 Dex. Half speed. | **Not modeled.** | — (future) |
| **Fascinated / Asleep** (`fascinated`,`asleep`) | A: **skip** (fascinate: takes no action; a threat/hit ends it). Asleep = helpless until woken. | Skips turn; flat-footed; a hit breaks it; sneak-eligible. | ✓ |
| **Charmed** (`charmed`) | E: treats caster as friend — **won’t attack the party**; a hostile act can break it. | Won’t attack party; may heal own side; a hit breaks it. | ✓ |
| **Flat-footed** (`flatFooted`) | D: **lose Dex to AC & CMD**; no AoO; no immediate actions. | Denied Dex (−2 base proxy); sneak-eligible; cleared when the creature acts. | ✓ (abstraction) |
| **Dazed** | A: **skip** (no actions), no AC penalty. | **Not modeled.** | — (future) |
| **Cowering** | A: **skip**; −2 AC, lose Dex. | **Not modeled.** | — (future) |
| **Shaken / Frightened / Panicked** | −2 atk/saves/skills (shaken); flee (frightened/panicked). | **Not modeled** (game has a separate morale/flee system for AI). | — (future) |
| **Confused** | Random d% each round (act / babble / self-harm / attack nearest). | **Not modeled.** | — (future) |
| **Fatigued / Exhausted** | Str/Dex penalties; can’t run/charge. Act normally otherwise. | **Not modeled** (no encounter-day fatigue). | — (n/a) |

---

## Discrepancies with RAW

### Resolved 2026-07-01 (deployed to TESTBED, pending Tobis playtest → prod)
1. **Prone AC now direction-correct.** `_enemyAC` takes a `ranged` flag: prone = **−4 AC vs
   melee, +4 AC vs ranged**. Ranged = an explicit ranged weapon (`_playerAttack` passes
   `ranged`) or a ranged-touch spell (all `{touch}` calls except the magus melee touch,
   which passes `{melee:true}`). Enemy melee vs a prone hero (line ~2308) was already −4.
2. **Sickened / Nauseated split.** New `nauseated` flag = the turn-loss effect (Stinking
   Cloud, `_abSaveDebuff`), correctly named; hero + enemy both skip while nauseated; cleared
   between rooms + by dispel; added to `ccd()`. True **sickened** now = −2 attack/damage AND
   −2 **all saves** (`_partySaveMod`, `_enemySave`), **no turn loss, no AC penalty** (the
   old −2 AC removed). The magus spellstrike rider now applies real sickened.
3. **Slowed restricts heroes.** A slowed hero is capped to **one attack** (no full-attack
   iteratives, in `_playerAttack`) and takes **−1 to hit**; slowed targets are −1 AC. (−1
   Reflex still not applied — see deferred.)
4. **Stunned −2 AC.** Stunned targets take −2 AC (in `_enemyAC` and the hero-target AC),
   on top of the existing turn-skip.

### Still deferred (minor / abstracted)
- **Slowed −1 Reflex** — save helper is generic (all saves); adding −1 only to Reflex needs
  per-save tagging. Skipped to avoid nerfing all saves.
- **Grappled martial nuance** — no 2-handed-weapon lockout, no AoO suppression (abstract
  weapon model).
- **Prone attacker’s own −4 melee** — moot: everyone stands (a move action) before striking.
- **Enemy ranged vs prone hero** — enemies attack via `_enemyMelee` (−4, correct); no enemy
  ranged-attack path to apply the +4.

## Not modeled (candidates, in rough priority)
`nauseated` (relabel the enemy-sickened case), `entangled` (web/tanglefoot; concentration
DC 15 + level), `pinned` (grapple escalation; no somatic casting), `dazed`, `cowering`,
`confused`. Shaken/frightened/panicked are partly covered by the AI flee/morale system.

## Central hooks (where to enforce)
- Turn gating: hero `_advanceToActor` (~L1408), enemy turn (~L1359) and `_enemyAct`.
- Cast gating: `_useAbility` (~L3660; grapple concentration block ~L3752).
- AC modifiers: `_acPenalty` (~L1912) and `_enemyAC` (~L4190).
- “Already CC’d” helper: `ccd(o)` (~L351).
