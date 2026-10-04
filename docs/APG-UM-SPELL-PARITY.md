# APG / UM Spell Parity Ledger

Toby (2026-09-29): "start bringing in spells from APG and UM." Sister ledger to
docs/CRB-SPELL-PARITY.md; the same confirmed parity rules apply:

1. The spell should be as similar to PF1 as it can be.
2. The appropriate casters must have access — class list, domain, specialty or
   known home rule — BOTH prepared and spontaneous.
3. The spell may be adapted to fit the game's format (adaptations named in the
   spell's own description).

Ground rules for every port (the standing spell-import checklist): PF1 numbers
wherever the dungeon can hold them; range decides targeting (personal → self,
touch → ally, close+ → enemy/aoe); duration decides persistence (rounds or
min/level → room; ≥10 min/level → dungeon-long); wire all four points (SPELL
def, per-class injection at the PF1 unlock level, post-override normalization
if a baked copy exists, the bot doctrine sets so bots cast it).

Casters on the roster and where their lists come from: bard, cleric, druid,
paladin, ranger, sorcerer, wizard (CRB + APG + UM additions); oracle and
inquisitor (APG classes — their lists are the cleric list / their own APG list
plus the APG and UM additions); magus (UM class — its own list); antipaladin
(APG); bloodrager (ACG — scope pending, TOBY-QUESTIONS 16c); the theurge is the
wizard + cleric lists.

Class-level notes: magus and inquisitor are 6-level casters (1st at 1, 2nd at
4, 3rd at 7, 4th at 10, 5th at 13, 6th at 16); rangers, paladins and
antipaladins keep 1st-level spells from level 1 (Toby) but 2nd/3rd/4th at
7/10/13; the bard is a 6-level caster.

Status legend: ✅ in game · 🔧 adapted (note says how) · 📋 queued (batch) ·
🚫 impractical (reason).

## Already in game before this ledger (APG / UM / other, ported alongside the CRB work)

Breath of Life (APG), Fire Snake (APG), Suffocation (APG), Vanish (APG),
Blessing of Fervor (APG), Darkvision Communal (UC), Stoneskin Communal (UC),
Protection from Evil Communal (UC), Force Punch (UM, magus), Bladed Dash (UM,
magus), Frostbite (UM, magus/druid — as the magus's spellstrike), Elemental
Body (UM, magus version), Dimensional Blade, Undeath to Death.

## Batch A1 — the opening five (v3.37.175) ✅

1. **Ear-Piercing Scream** (UM: Brd 1, Inq 1, Magus 1, Sor/Wiz 1) 🔧 — one
   foe, 1d6 sonic per two caster levels (max 5d6) and DAZED a round; Fortitude
   for half and no daze. Adaptation: dazed is the engine's stunned (the turn is
   lost either way).
2. **Frigid Touch** (UM: Magus 2, Sor/Wiz 2) 🔧 — melee touch, 4d6 cold and
   STAGGERED a round; a natural 20 leaves it staggered for the room (PF1: 1
   minute). Adaptation: staggered is the engine's slowed (one action a turn).
   The undead do not feel the cold (the engine's standing undead cold immunity).
3. **Stone Call** (APG: Drd 2, Rgr 2, Sor/Wiz 2) 🔧 — up to 6 foes, 2d6
   bludgeoning, NO save, no SR (new aoe flags `noSave` / `noSR`). The lingering
   rubble as difficult terrain has no surface.
4. **Sirocco** (APG: Drd 6, Sor/Wiz 6) 🔧 — up to 6 foes, 4d6 fire and FATIGUED
   (new aoe rider `fatigueRider`, for the room; the unliving do not tire); a
   flyer that fails its save is torn from the sky (new rider `groundRider`:
   prone and grounded until it stands, then it flies again — enemyAI hook).
   Fortitude halves and negates the riders. Adaptation: the wind covers the
   field; fatigue lasts the room, not the spell's duration.
5. **Cleanse** (APG: Clr 5, Inq 5, Orc 5) 🔧 — one ally heals 4d8 + CL (max
   +25) and every one of blindness, stun, sickness, nausea, paralysis and slow
   ends on them (new heal rider `cleanseRider`). A curse is not on the list
   (Remove Curse); the ability-damage clause has no surface.

## Queued (batches of 5, in priority order — pending TOBY-QUESTIONS 16a)

- **Batch A2 — magus & inquisitor staples (UM/APG):** Chill Touch is CRB;
  new: Force Hook Charge (UM Magus 2 — close on a foe and strike, the engine's
  "charge"), Bladed Dash Greater (UM Magus 5), Litany-family is UC (out of
  scope), Cast Out (APG Inq 4 — Dispel + banish an outsider), Bloodhound is
  utility 🚫. Candidates: Force Hook Charge, Greater Bladed Dash, Cast Out,
  Coward's Lament (APG Inq 4 — a foe that does not attack you is shaken/−AC),
  Blessing of the Salamander (APG Rgr 4 — fast healing, fire resistance).
- **Batch A3 — arcane blasts & control (APG/UM):** Ball Lightning (APG 4 —
  storm engine), Aqueous Orb (APG 3 — engulf, storm engine), Boneshatter (UM 5
  — 1d6/level + exhausted, Fort partial), Umbral Strike (UM 8 — 15d6 ranged
  touch, blinds), Icy Prison (UM 5 — Reflex or helpless in ice).
- **Batch A4 — divine (APG/UM):** Blessing of Fervor is in; new: Burst of
  Radiance is not APG/UM (skip); Rebuke (APG Inq 4), Fester (APG Inq 3 —
  healing on the foe is halved), Threefold Aspect 🚫, Holy Ice (Chelish, skip),
  Fleshworm Infestation (UM Clr 4 — 1d4 rounds of 1d4 + staggered),
  Curse of Disgust / Terrible Remorse (UM), Absorb Toxicity 🚫.
- **Batch A5 — bard & oracle (APG/UM):** Cacophonous Call (+Mass) (APG Brd
  2/5 — nauseated), Echolocation (UM — blind-sight), Wall of Sound (UM Brd 4 —
  wall engine), Saving Finale (APG Brd 1 — an ally rerolls a save), Purging
  Finale (APG Brd 2 — end a condition on an ally).
- **Batch A6 — self & party wards (APG/UM):** Vampiric Shadow Shield (UM 5),
  Fiery Body (UM 9 — self: fire immunity, +2d6 fire on touches), Winds of
  Vengeance (APG 9 — flight + ranged deflection), Fickle Winds (UM 5 — Wind
  Wall that follows the party), Elemental Aura (APG 3 — 2d6 to melee attackers).

## Impractical (🚫) — and why

The CRB ledger's families apply unchanged: divination, travel, social, downtime,
crafting, object-target, scenery illusions, and cure spells for conditions
heroes never suffer (fatigue, poison, disease, ability damage, negative levels —
TOBY-QUESTIONS 16d). Named APG/UM examples as they are met go here.

## Process

One batch per release alongside Josh's bugfixes; each batch updates this ledger
in the same commit. Bots learn every spell through the doctrine sets (aoe/touch
= attack, heal never waits) and REACH it through the per-run wildcards (v3.37.177:
one random tier-0/1 spell per spell level per run from what the default loadout
left out — list a spell in PRIORITY only to make it a staple); descriptions teach
every adaptation; domtests pin each batch.

Magus note: the magus kit turns every `touch` spell into an Imbued Shot
(spellstrike) — Frigid Touch sits in the magus's Imbued Shots submenu, not the
Spellbook, and is not a loadout spell for it (minLevel 4 holds).
