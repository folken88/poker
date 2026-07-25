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

## Phase S4 — semantic combat EVENTS (sighted/blind consistency; approved 2026-07-25)

The server narrates in PROSE (`_note`) and the blind layer re-derives meaning from
text (sometimes by regex); the sighted UI renders from state — three surfaces, one
truth, endless drift. S4: every state change emits an EVENT alongside its note —
`{type:'attack', actor, target, hit, dmg, riders}`, `{type:'condition', who, what,
applied|expired, source}`, `{type:'turnSkip', who, reason}` — and prose is GENERATED
from events by one renderer with one verb table. Blind priorities (urgent/event/
ambient) + Josh's verbosity rules become per-event-type POLICY. A state change with
no event becomes a lint error — the "silent mechanic" bug class dies structurally.
NOT an invention: jsonl lines already carry `phase`/`side`/`kind` (proto-events).
Migration: `_note(prose, sound, {ev})` rides alongside; renderers flip event-first
surface by surface. S3 registry effects emit condition events natively.

## Phase S5 — trait-driven creatures + ONE resolution layer (PF1 consistency)

PF1 = four resolution procedures (attack, save, SR, damage typing) + a trait
ontology. Today: per-handler saves, name-REGEX immunity (`mindImmune` matches
/golem|skelet|zombie/), and `_spellWorksOn` (bot preview) as a SEPARATE
implementation from cast-time refusals. S5: (1) MON entries + heroes carry a real
traits block `{type, subtypes, senses, immune[], resist, dr}` — IMPORTED from the
content DB's Foundry raw_json where possible (real bestiary data, 380 monsters,
no hand-flagging); (2) `resolve.save(target, {kind, tags})` consults traits ONCE —
Elemental Body becomes `grants immune: [paralysis, stun, …]` and every current and
FUTURE hold/stun source respects it automatically (the .86 patch needed 3 hand
guards; under S5: zero). `_spellWorksOn` becomes a thin preview over the same check.

## Phase S6 — enemy-caster unification (the parity mandate made structural)

`_lichCast` owns parallel implementations of fireball/hold/fly — why concealment
reached heroes before enemies and every new hero spell silently widens the parity
gap. S6: enemies cast the SAME SPELL entries through the same resolution layer; AI
brains only CHOOSE, never IMPLEMENT. Mostly falls out of S5. New hero spells then
enrich enemy casters for free.

## Explicitly NOT redesigned

Per-room refresh + arcadey economy (locked — S4–S6 conform MECHANISMS, Tobias keeps
deciding which RULES apply); client.js split (deferred — S4 reduces blindMode's
text-coupling without touching client structure); the turn loop / room model (not a
bug generator).

## Sequencing (full arc)

S1b/c → S2 (pf1core) → S3 (registry) → S5 (traits+resolution; prototype the trait
IMPORT during S3 design — shared schema) → S4 (events) → S6 (unification).
S4 and S5 are EACH bigger than S1–S3 combined; same discipline throughout.

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
