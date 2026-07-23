# Stabilization Plan — kill the bug generators, not the bugs

> Approved by Tobias 2026-07-23 ("stabilize & optimize, go for it").
> Method: the proven Phase-2 gated-seam pattern — one seam per deploy, testbed →
> domtest → gated prod, ratchet tests so a seam can't silently un-happen.
> Repo copy: `docs/project/STABILIZATION-PLAN.md` (keep both in sync).

## Why (the four bug generators)

A month of Josh-QA patches (v3.37.60–.81) traces almost every defect to four
structural generators. Patches fix instances; these seams remove generators.

1. **Parallel paths that drift** — "someone attacks someone" is written ~6 times:
   hero→enemy (`_swingVsAC`), enemy→hero (`_enemyMelee`), enemy→summon (inline in
   `_enemyAct`), enemy hook (`_enemyHook`), enemy spellstrike (`_enemySpellstrike`),
   dominated-foe & party-summon attacks (Dungeon.js `_advanceToActor` area).
   Evidence: Challenge swift for AI/full-turn for player (.76); concealment for
   heroes but not enemies (.78); Erinyes "shoots" heroes / "smashes" summons (.81);
   `ranged` not copied to instances (.65).
2. **Silent mechanics** — passives/rules fire with no narration; for a blind-first
   game narration IS the UI. Evidence: passive domains "disappeared" (.81),
   held-flyer grounding read as cheating (.81), held-turn skips read as random (.77).
3. **Ad-hoc condition state** — a grapple is 5 fields; held is 2; every effect
   hand-wires apply/tick/reset/serialize/dispel/AI/narration. Evidence: dispel
   offered physical conditions (.77), stun-vs-hold confusion (.81), the
   "add every new flag to the room reset or it leaks" pattern.
4. **Rules divergence across apps** — poker vs PGM vs content-DB three-way
   pf1core drift; sync script papers over it (see pf1-shared-pipeline).

## Phase S1 — attack-resolution chokepoint (enemyAI first)

**S1a (v3.37.82, this deploy):** `_foeSwing(e, targetAC, opts)` +
`_foeMissText(e, r, who, withRoll)` in enemyAI.js — the ONE place an enemy
attack roll gets its sound (pool > single-with-ranged-miss rule > archetype)
and its ranged/melee verbs. Rewire the two generic duplicating sites:
enemy→hero melee and enemy→summon. Ratchet: the atkSounds-override pattern
appears exactly once in enemyAI.js; sites 224/332 gone.

**S1b (next):** absorb the AC-penalty stack (`effAC` computed 3× with drifting
term lists — melee has stunned/slowed terms, hook and spellstrike don't) into
`_foeTargetAC(e, target)`. Then route hook + spellstrike rolls through
`_foeSwing` (keep their bespoke narration).

**S1c:** unify Dungeon.js dominated-foe + party-summon attack blocks through the
same chokepoint (they currently have their own verbs/no sound rules at all).

**S1d:** hero-side: `_swingVsAC` is already central — audit its call sites for
site-local verb/sound divergence; extract narration verbs to one table shared
with `_foeSwing` (the "consistency-of-reporting" standard as code, not prose).

## Phase S2 — pf1core extraction (already locked, mechanical)

Vendor-and-sync per the locked decision (NOT submodule/monorepo): populate
`github.com/folken88/pf1core` from poker's `pf1data/* + game/character.js +
game/combat.js + pf1core/index.js`, add sync scripts both ways (follow
`pgm/scripts/sync-from-poker.sh` precedent), purity gate rides along. Exit
criterion: "fix dispel in one place, fixed in both apps."

## Phase S3 — effect/condition registry (deepest cut, incremental)

One `EFFECTS` table; each effect declares:
`{ key, label, physical (dispel-immune), blocksTurn, blocksFly, apply(t),
tick(t), expire(t), roomReset: bool, narrateApply/narrateExpire, serialize }`.
Members/enemies carry an effects list; legacy flags (`grappled`+4 friends,
`paralyzed`/`heldDC`, `stunned`, `_fomCastRounds`…) migrate ONE AT A TIME behind
accessors — never a big-bang. New effects MUST use the registry from day one.
Retires: the room-reset checklist, the dispel-eligibility list, silent passives
(narration hooks are part of the declaration), the client turn-boundary-reset
class of bug (blocksTurn is queryable).

## Rules of engagement

- One seam per deploy; behavior byte-identical unless the changelog names the
  narration/rule intentionally changed.
- Every seam lands with a domtest ratchet that makes regression loud.
- Source-regex domtests get REPLACED by behavioral tests as the code they
  guarded becomes a callable function.
- Update this doc + POKER-DUNGEON-MAP.md when a seam lands (one line each).
- client.js split stays DEFERRED (locked decision #4). Its bug class is
  VoiceOver focus, not logic drift — different medicine.

## Status log

- 2026-07-23 S1a shipped (v3.37.82): `_foeSwing`/`_foeMissText` chokepoint,
  2 generic sites rewired, ratchet in domtest 93.
