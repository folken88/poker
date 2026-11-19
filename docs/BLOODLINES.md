# Sorcerer Bloodlines (PF1 Core Rulebook) — engine notes

v3.37.169 (2026-09-23). Data: `backend/src/pf1data/bloodlines.js`. Runtime: `_bloodlineSetup` /
`_bloodlineApply` / `BL_TEMPLATES` in `game/dungeon/abilities.js`. Picker: the lobby profile row
(`lobby:setBloodline`, sorcerers only). Persistence: `players.bloodline` ('none' = the old model).

## The rules as the engine reads them
- **Bonus spells** (class levels 3/5/7/…/19) are always known and do not count against Table 3-15.
  A sorcerer with a bloodline therefore loses the "+1 free pick per spell level" the engine used
  before as a stand-in. A bonus spell the engine lacks (e.g. Tongues, Veil, Identify) is skipped and
  the info entry names it. A bonus spell not on the sorcerer's list (Bless, Flame Strike, Entangle…)
  is appended as a spontaneous entry.
- **"Per day" = per room** (the game's day, as for domains). "3 + Cha" uses reads the Cha modifier.
- **Powers** become pad entries in the Racial Abilities submenu (labelled "Bloodline Powers", or
  "Blood & Racial Abilities" for a drow sorcerer). Passives fold into AC, saves, SR, DR, energy
  resistance/immunity and flight and are re-applied every room; the free "Bloodline: X" entry speaks
  them.

## Translations that are NOT the book (flagged in each power's desc)
- Rays are ranged touches for 1d6 (Heavenly Fire 1d4) + ½ level. Heavenly Fire follows the Holy Smite table
  since v3.37.185 (full to evil, half to neutral, nothing to good; the book also heals good creatures).
- Corrupting Touch / Grave Touch are the book's no-save melee touch attacks since v3.37.185.
- Claws are the book's power since v3.37.187: each use is one round of two claw attacks at full BAB (1d4 + Str,
  magic at 5th, 1d6 at 7th, +1d6 energy at 11th), 3 + Cha rounds a room.
- Fated is always on (book: the first round only).
- Conviction / It Was Meant To Be ride the Luck-domain reroll (next missed attack).
- Wings of Heaven is a room-long Fly, once per room.
- Draconic is ten bloodlines since v3.37.187, one per CRB dragon (`draconic` = red, `draconic_<colour>` the
  rest): the type sets the claw energy, the resistance, the breath (cone 4 foes, line 2), the level-20 immunity and
  the arcana (+1 damage per die on spells of that energy, sorcerers). Elemental is still air (electricity) only.

## Not modelled yet (written down; the picker says "(not yet)")
Arcane Bond, Metamagic Adept, School Power, Arcane Apotheosis; Long Limbs, Unusual Anatomy; Touch of
Destiny, Within Reach, Destiny Realized; Laughing Touch, Woodland Stride, Fey Magic; Incorporeal
Form; Added Summonings; every arcana; bonus feats; the poison-save riders; crit/sneak immunities.

## Bloodragers (Advanced Class Guide) — v3.37.188
Toby, 2026-11-18: 'use the real acg when it makes sense for our format.' Each bloodline carries a second
table, `rager`: powers at 1 / 4 / 8 / 12 / 16 / 20, bonus spells at 7 / 10 / 13 / 16 (once a room each, like
the rest of a bloodrager's spells). A bloodrager reads that table; a sorcerer reads `powers`.

- **Only while bloodraging.** Every power needs the rage unless its entry says `constant` (the level-20
  ones). `_bloodlineSetup` folds the while-raging passives into `m._bloodRage`; `_bloodrageOn` (called from
  the Rage branch of `_abBuff`) applies them and speaks one line; `_bloodlineApply` clears them at the door.
  An active power carries `needsRage` and is refused with the reason until the rage is on.
- **Save DCs** are 10 + ½ level + Constitution (`dcStat: 'con'`).
- **Claws** (abyssal, draconic): 1d6, magic at 4th, 1d8 at 8th, +1d6 energy at 12th, at will while raging.
- **On-rage choices** ('when you enter a bloodrage you may…') are free-action buttons (`effect: 'bloodboon'`),
  one per group and bloodrage: Demonic Bulk, Arcane / Greater / True Arcane Bloodrage, Fury of the Fey. A
  hireling takes the first option of each group as it rages.
- **Strikes**: Elemental Strikes and Hellfire Strike are swift actions lasting one round (`m._bloodStrike`);
  Destined Strike is a free action on the next melee swing. `_bloodHitRiders` (called for every melee swing
  that connects, weapon or claw) adds the energy, Angelic Attacks and the critical-hit riders (Staggering
  Strike, Confusing Critical). A hireling spends them as it attacks.
- **Against critical hits**: `m.bloodCritShrug` (0.5 Unusual Anatomy, 1 the level-20 immunities) is read by
  `_critShrug` at the three enemy swing sites in enemyAI.
- **Typed saves**: Diabolical Arrogance is `m.bloodSaveVs`, read by `_partySaveMod` (+4 on tagged saves).
- **Not yet (21)**: Abnormal Reach, Aberrant Fortitude, Demonic Aura, Disruptive Bloodrage, Caster's Scourge,
  Caster's Bane, Conviction, Angelic Protection, Defy Death, Unstoppable, Victory or Death, Dragon Form,
  Elemental Form, Leaping Charger, Blurring Movement, One with Nature, Hellfire Charge, Frightful Charger,
  Ghost Strike, Frightful Strikes, Incorporeal Bloodrager. Three wait on a ruling (TOBY-QUESTIONS 14j).
- **PGM**: the data file is poker's; the mixins are synced; PGM's shim has its own `_partySaveMod`
  (patched by pgm188.py).
