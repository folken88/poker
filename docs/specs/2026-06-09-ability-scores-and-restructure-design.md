# Ability Scores + PF1 Combat Math + Codebase Restructure — Design

Date: 2026-06-09
Status: Approved (pending final spec review)
Owner: Tobias

## 1. Goal

Introduce real PF1 **ability scores** (STR/DEX/CON/INT/WIS/CHA) that drive
everything — to-hit, damage, saves, HP, spell DCs, bonus spells — replacing the
hardcoded placeholder constants (`ABILITY_MOD = 4`, `CAST_MOD = 4`). Do it in a
way that **introduces a cleaner long-term structure** as we go (strangler), so
the math lives in one place instead of scattered through the 3,900-line
`Dungeon.js`. Races and a player-facing ability editor come later, on the same
foundation.

## 2. Approach: strangler / incremental

Build the new structure **through** the feature, smallest-risk-first, because this
is a live, single-server game with **no automated test suite** and player-gated
deploys.

- A new pure-data layer + one derived-stats core lands first and the existing
  code is routed through it.
- Each phase ships and is verified on the **testbed** (`poker-test`,
  `http://192.168.1.200:32096`, isolated DB) before promotion to prod.

## 3. Target module structure

```
backend/src/pf1data/            (pure data + pure functions — no game state)
  classes.js                    extend: castingAbility, default ability priority,
                                ASI pattern, attack-stat rule (STR / DEX-if-finesse)
  abilityScores.js   NEW        point-buy cost table, mod(), the 17/14/14/12
                                allocator, validation, bonus-spell table
  characterProfiles.js NEW      per-character ability priority + overrides + ASI
                                pattern; class default fallback
  races.js           NEW (P2)   race -> ability modifiers
  spells.js          (P3)       SPELL defs extracted from abilities.js (shared)
  kits/<class>.js    (P3)       per-class kit split + kits/index.js barrel
  xp.js                         unchanged
backend/src/game/
  character.js       NEW CORE   deriveCharacter(...) -> single source of truth
  Dungeon.js                    consumes character.js; later carved into
                                combat/turn/loot/abilities modules (P3)
```

## 4. The derived-stats core — `character.js`

One function is the single source of truth. Both the poker hero-card display and
dungeon combat call it; no duplicated math.

```js
deriveCharacter({ cls, level, race, baseScores, gear, weaponKey }) => {
  scores:  { str, dex, con, int, wis, cha },   // base + race + ASI
  mods:    { str, dex, con, int, wis, cha },
  hp,                                          // hd*level + CON mod*level + feats
  ac, bab,
  saves:   { fort, ref, will },                // base progression + CON/DEX/WIS mods
  attackStat,                                  // 'str' | 'dex' (finesse/ranged)
  toHit, dmgBonus,                             // from attackStat per the rules below
  iteratives,                                  // [0, -5, -10, -15] by BAB
  spellDC(spellLevel), castingMod, bonusSlots
}
```

This **deletes** `ABILITY_MOD` and `CAST_MOD`; every consumer reads `mods`/`toHit`
/`dmgBonus`/`spellDC` from here.

## 5. Ability-score data model

- **Storage:** one new JSON column `ability_scores` on `players` (same
  `ensureColumn` pattern as `gear` / `class_xp`), holding the **base 25-point
  array** (pre-race, pre-ASI): `{str,dex,con,int,wis,cha}`. Seeded on first load
  from the character's profile via the allocator. One-time backfill stamps every
  existing player/bot.
- **ASI** (every 4 levels: 4/8/12/16/20, +1 each) and **race** mods are computed
  at derive time from `(level, asiPattern)` and `(race)` — **not stored** — so they
  stay correct as a character levels.
- **Editing (later):** players edit the **base array**, re-validated against the
  25-point buy and the caster-stat rule. The column already supports this.

## 6. Point-buy allocator

Standard PF1 cost table:

| Score | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Cost | -4 | -2 | -1 | 0 | 1 | 2 | 3 | 5 | 7 | 10 | 13 | 17 |

`pointBuyArray(priorityList)` allocates **17 / 14 / 14 / 12, rest 10** down the
priority order (= exactly 25). Verified against both given examples:

| Character | Priority | -> array | total |
|---|---|---|---|
| Sirona (Paladin STR/CHA) | STR·CHA·CON·(DEX) | STR17 CHA14 CON14 DEX12 | 25 |
| Wizard | INT·DEX·CON·(WIS) | INT17 DEX14 CON14 WIS12 | 25 |

Rules enforced by validation:
- **CON** is the near-universal P3.
- A **caster's casting stat must be P1 or P2** (INT wizard/magus; WIS cleric/druid;
  CHA sorcerer/bard/paladin/oracle).
- **Finesse weapon ⇒ DEX leads** (DEX is the attack stat, so it sits P1/P2).
- The leftover 2 points (P4 = 12) default to a sensible save/utility stat
  (DEX for a martial's AC, WIS for a Will save), overridable per character.

## 7. Per-character ability profiles

Profiles live in `characterProfiles.js`, keyed by character name (like
`character_voices.js`), each: `{ priority:[...], overrides?:{}, asiPattern:[...] }`.

- **Derivation:** for each named character I infer the priority from
  `class x weapon (finesse->DEX) x role x casting stat`, run the allocator, and
  present the **whole roster as a table for approval/correction** (this is the
  first implementation step). Generic/unnamed party members use the class default.
- **ASI pattern:** an ordered list cycled at each +1 (level 4 -> pattern[0],
  8 -> pattern[1], ...). Single-key builds bump one stat (wizard `['int']`,
  rogue `['dex']`); dual-key builds alternate (paladin `['str','cha']`).

## 8. Combat math integration

The placeholder constants are replaced by real ability mods, and the
`floor(level/2)` damage ramp is **dropped** (high-level scaling moves to STR +
iteratives + class features). Tuned on the testbed.

| Calculation | Today | After |
|---|---|---|
| Spell DC | `10 + level + CAST_MOD(4)` | `10 + spellLevel + castingMod` |
| Saves | base progression only | `+ CON / DEX / WIS` mods |
| HP | `hd * level` | `+ CON mod * level` |

### To-hit and damage by weapon type

| Weapon | To-hit | Damage bonus |
|---|---|---|
| One-handed melee | STR mod | **STR x1.0** |
| Off-hand melee | STR mod | **STR x0.5** |
| Two-handed melee | STR mod | **STR x1.5** |
| Ranged (house rule) | DEX mod | **DEX x1.0** |
| Finesse melee (house rule) | DEX mod | **DEX x1.0** |
| Caster at-will cantrip | casting-stat mod | **casting-stat mod** |

### Iterative attacks (full PF1, everyone)

Every attacker (weapons **and** the caster cantrip) gains BAB-based iteratives:
- 2nd attack at **BAB 6** (−5), 3rd at **BAB 11** (−10), 4th at **BAB 16** (−15).
- This is the new high-level scaling. Must mesh with the existing haste /
  rapid-shot / cleave multi-attack systems without double-counting (impl detail).

### Caster at-will cantrip (Ray of Frost / Produce Flame)

- Uses **casting stat** for both to-hit and damage, and gets the **iterative**
  count above — so a caster's at-will keeps pace with martials.
- **Element switching:** the cantrip can change damage type (e.g. cold -> fire)
  to bypass a foe's resistance. Default control: AI auto-picks a non-resisted
  element; a human caster auto-adapts (a manual cycle can be added later).

### Bonus spells

High casting stat grants PF1 bonus spells/day. Default: apply to **slot-based**
casters (sorcerer / oracle / bard) via the existing slot table now; defer the
**room-cast** classes (wizard / druid — "one casting of each per room") to the
tuning pass so the per-room economy isn't disrupted.

## 9. Phased rollout

Each phase ships independently and is testbed-verified before prod.

1. **Phase 1 — ability scores (the feature).** `abilityScores.js` + `character.js`
   + the `ability_scores` DB column + seed profiles (roster table approved first)
   + route combat math through `character.js` (delete `ABILITY_MOD`/`CAST_MOD`),
   incl. the damage rules, iteratives, cantrip changes. Tune curve on testbed.
2. **Phase 2 — races.** `race` column + `races.js` + apply mods in `deriveCharacter`.
3. **Phase 3 — structure.** Extract `spells.js`, split `kits/<class>.js`, carve
   `Dungeon.js` into combat/turn/loot/abilities modules. Behavior-preserving
   refactor, verified on testbed.
4. **Later — player ability-score editor.** The data model already supports it.

## 10. Open / tuning items (not blockers)

- **Damage curve tuning** on the testbed — dropping the `floor(level/2)` ramp
  changes the low- and high-level power curve; verify martials and casters stay
  viable at depth.
- **Iterative meshing** with haste / rapid-shot / cleave (avoid double attacks).
- **Bonus-cast for room-cast casters** (wizard/druid) — economy decision deferred.
- **Cantrip element-switch UI** for human casters — auto-adapt now, manual later.

## 11. Testing

No unit-test suite exists. Verification is **testbed-based**: deploy to
`poker-test`, drive it via browser automation + API/socket checks (boot a run,
attack with each weapon type, cast cantrips, level past BAB 6/11/16, check
DCs/saves/HP against expected PF1 numbers), then promote to prod during a
no-players window via the gated rebuild.
```
