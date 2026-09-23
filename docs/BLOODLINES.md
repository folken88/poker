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
- Rays are ranged touches for 1d6 (Heavenly Fire 1d4) + ½ level; Heavenly Fire burns any foe (book:
  evil only, heals good).
- Corrupting Touch / Grave Touch are Will saves (like Doom) instead of no-save melee touches.
- Claws are a room-long +2 damage (+3 from 7, +1d6 from 11) instead of two claw attacks.
- Fated is always on (book: the first round only).
- Conviction / It Was Meant To Be ride the Luck-domain reroll (next missed attack).
- Wings of Heaven is a room-long Fly, once per room.
- Draconic defaults to red (fire); Elemental to air (electricity). Other colours/elements on request.

## Not modelled yet (written down; the picker says "(not yet)")
Arcane Bond, Metamagic Adept, School Power, Arcane Apotheosis; Long Limbs, Unusual Anatomy; Touch of
Destiny, Within Reach, Destiny Realized; Laughing Touch, Woodland Stride, Fey Magic; Incorporeal
Form; Added Summonings; every arcana; bonus feats; the poison-save riders; crit/sneak immunities.
