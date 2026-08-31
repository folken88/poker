# Questions for Toby — the standing ruling queue

One consolidated place (Josh's ask, 2026-08-29: "retool your method of getting
questions in front of him... compile it and give it to him in a batch"). Every
open design/rules question lives HERE, newest first. When Toby rules, the answer
moves to the Ruled section with the version that implemented it.

## Open

1. **Buff-flavored sound assets** (Josh, 2026-08-30): "a buff spell should sound
   like it's buffing you... the sound of a hammer infers someone just got their
   head crushed." Divine Favor and Divine Power had inherited your ATTACK sounds
   (mjolnir / warhammer-smite) and confused him mid-fight; v3.37.138 moved them
   to interim buff-family sounds (spell_buff_invoke / spell_prayer). The pool
   has almost no dedicated buff/shimmer/chime assets. Options: (a) point at
   buff-appropriate files in your Foundry media library (like the tarkov_stim
   find), (b) approve generating a few short SFX on your ElevenLabs account,
   (c) name your file categories so future assignments stay in-lane. Sound
   round 3 is also still queued: mage armor, shield, greater invisibility.

2. **Blessing of Fervor on the paladin list** — flagged by the range audit:
   BoF is a cleric-4 APG spell, not paladin-4 (the paladin copy predates the
   PF1-ladder work). Keep it as a home-rule paladin capstone, or swap it for
   the book's Holy Sword-style option?

## Standing policy (Toby, 2026-08-30)

- **Bonus typing:** same-type bonuses never stack — and PF1 has enough bonus
  categories that we never bend this; instead we CATEGORIZE correctly. A magic
  item carries the bonus type of the spell that crafts it (amulet of natural
  armor = Barkskin = enhancement to natural armor); racial bonuses (nagaji +1
  natural armor) are their own type and DO stack with enhancement. Apply this
  typing to every new bonus imported.
- **PF1 first:** "pf1 rules always to start with, then deviate when we have to."

## Ruled

- **Divine Favor + Divine Power don't stack** (both luck; bigger stands) —
  confirmed 2026-08-30, shipped v3.37.135 (the shared luck channel).
- **Martial casters get their PF1 spell lists on the PF1 ladder** (1st at
  level 4, 2nd at 7, 3rd at 10, 4th at 13 — the old spells-from-level-1
  paladin home rule is retired): paladin, antipaladin, ranger, bloodrager —
  v3.37.136.
- **Stoneskin (Communal) is room-only** (the communal casting divides the
  10-min/level duration below the dungeon-long bar, per PF1); solo Stoneskin
  stays dungeon-long. Tier rule reaffirmed: 10-min/level+ = whole dungeon,
  round/minute-per-level = room — v3.37.136.
- **Spiritual Weapon and Spiritual Ally may fight side by side** (one of EACH,
  not two of one), and Toby's home rule: both ride the caster's active buffs
  (Divine Favor, Prayer, Weapon of Awe...) — v3.37.136 (the engine's
  _swingVsAC already carried the buffs; the ally joins the same engine).
- **Spiritual Ally is an angel** (APG import approved; keep bringing over all
  CRB spells) — v3.37.136.
- **The extract sound is the hypo-stim** — Toby's tarkov_stim.mp3 from the
  Foundry media library — v3.37.136.
- **Enemy CR cap** ≤ highest hero level +2 — v3.37.121.
- **Prepared casters may duplicate spells / auto-fill empty slots** —
  already true by construction (slots are a per-level budget).
- **Ranged heroes get backup melee; melee get backup crossbows** — v3.37.121.
- **Dimension Door / Teleport tactics** (escape grapple, ferry an ally,
  safe-harbor; teleport = 2 rounds safe harbor) — v3.37.123.
- **10-min/level+ buffs last the whole dungeon** — v3.37.123.
- **Potions keepable/usable/offerable + PGM item store port** — ruled yes,
  queued as the next feature after CRB parity batches.
- **Time Stop free castings (1d4+1), Wish defaults incl. kill-unless-save,
  summons = simpler versions of existing monsters, more druid forms** —
  v3.37.125.
- **CRB parity ground rules** (as-PF1-as-possible; every correct caster gets
  each spell; adaptations named in descs) — confirmed 2026-08-26, ledger in
  docs/CRB-SPELL-PARITY.md.
