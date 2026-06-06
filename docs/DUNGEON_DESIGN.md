# 🗡️ "Hit the Dungeon" — side-game design

A silly, D&D-styled push-your-luck side-game inside Folken Poker. Broke or bored
players descend into the basement *beneath the poker hall* to fight PF1e monsters
on a simplified VTT and haul gold back up to the felt.

**Prime directive:** this NEVER affects poker mechanics. The only thing it does
to the poker economy is *add* gold to a player's stack (chips = gold = gp, 1:1).

---

## Player decisions (locked)

| Decision | Choice |
|---|---|
| Map / combat | **Room-crawl, menu combat.** Node-map of rooms; click a door to enter the next; tokens shown but combat is menu-driven (pick target + action), no square-by-square movement. |
| Build approach | **Lean MVP first** (solo runs), then layer in allies + richer maps/audio. |
| Party loot | **Even split** of total gold across all party members. |
| Spells | **Attack:** unlimited, single target. **Lightning Bolt:** up to **2 enemies**, **3-round cooldown**. **Stinking Cloud:** **all enemies** (each rolls a save), **3-round cooldown**. |
| Death (0 HP) | **Forfeit this run's gold AND any unbanked/unequipped loot.** Keep all existing chips, and any loot you equipped during the run. Risk = the unbanked winnings. |
| Run structure | **Endless descent**, bail anytime on your turn. Each deeper room is riskier + richer. **Occasional bosses / AI-character mini-bosses** (the best-geared bots) block the way down. |
| Reward size | **Modest & grindy** (~50–200g/room; solid run = a few hundred; deep run ~1–2k). Numbers exposed for easy tuning. |
| Foundry assets | **Placeholders now**, swap in real Foundry creatures/art/maps once the MCP bridge is reconnected. |

---

## Player flow

1. **Enter:** On the poker table there's a **🗡️ Hit the Dungeon** button. Clicking it
   vacates your seat (`table.stand`) and drops you into the dungeon screen. (You
   become a table spectator for audio purposes.)
2. **Descend:** You start in an entry room. Click a **door** to enter the next room
   → an encounter rolls from the table for the current **depth**.
3. **Fight:** Initiative is rolled. On your turn pick **Attack / Lightning Bolt /
   Stinking Cloud / Open next door / Bail**. Enemies (and later, AI allies) act on
   their turns automatically. Real PF1e-ish math: d20 + to-hit vs AC, damage rolls,
   crits/fumbles — reusing the existing `combat.js` resolvers.
4. **Loot:** Clearing a room drops **gold** (added to your run total, not yet banked)
   and occasionally a **+1 magic item**, which you can **Hock** (instant sell value)
   or **Equip** (wear it — upgrades that gear slot via `db.setGear`).
5. **Bail:** On your turn, **Bail** to climb out and **bank your run gold** (+keep
   equipped loot). You return to the table as a spectator with your richer stack.
6. **Death:** Drop to 0 HP → carried out. **Forfeit the run's gold + unbanked loot.**
   Existing chips/gear untouched.

**HP** = `30 + 10×(ring bonus) + 10×(cloak bonus)` (read from `db.getGear`). So a
gearless player has 30 HP; a +5 ring & +5 cloak player has 130 HP.

---

## Combat model (MVP)

- **Stats from gear** (reuse `combat.js`): weapon tier → to-hit/damage; armor+shield+ring → AC.
- **Attack:** d20 + weapon to-hit vs target AC; on hit roll weapon damage (crit on threat-confirm). Unlimited, single target.
- **Lightning Bolt:** auto-hits up to 2 chosen enemies; each takes `power`d6 (power = magic bonus, floor 2), Reflex save for half. **3-round cooldown.**
- **Stinking Cloud:** all enemies roll Fortitude; failures are **sickened** (–to-hit/damage) for a few rounds. No HP damage. **3-round cooldown.**
- **Enemy AI:** simple — pick a random living party member, attack (or use the
  creature's signature attack). Bosses hit harder / may have a special.
- **Initiative:** d20 + small dex-ish modifier; party + enemies in one order.
- Sounds reuse the existing fight pools (`fight_flesh/block/whiff/lightning/stink`).

## Encounter table (Ustalav underground — placeholder, swap with Foundry later)

Tiered by **depth band**; deeper = higher CR, more gold. Lore-fit = undead-heavy.

- **Shallow (depth 1–3):** dire rats, giant centipedes, goblins, kobolds, skeletons, giant spiders.
- **Mid (4–7):** zombies, ghouls, cultists (Whispering Way), skeletal champions, gray oozes, animated armor.
- **Deep (8+):** wights, shadows, ghasts, ogres, ettins, gibbering mouther, cult fanatics of Urgathoa.
- **Bosses (every ~5 rooms):** a beefed creature OR an **AI-character mini-boss** —
  one of the *best-geared bots* (highest `gearValue`) appears with stats derived
  from their gear, their token + name. Flavor: "the rich come down to protect their
  vein of gold." (Boss defeat = a fat loot drop. **Open Q:** does it also skim some
  of that bot's chips, or purely dungeon loot? Default: **dungeon loot only**, to
  keep zero poker-economy impact.)

**Loot:** mostly raw gold (modest curve). Small chance per room of a **+1 item** in a
random slot you don't already have at that tier → Hock (sell value from
`GEAR_SLOTS` pricing) or Equip.

---

## Party play (Phase 2)

- **Recruit up to 3 allies**, human or AI, before/at the start of a run.
- **AI ally:** pay **50g** from your pocket → that bot **leaves its poker seat**
  (`table.stand`) and joins, auto-fighting on its turns. Mercenary: takes part in
  the **even split**.
- **Human ally:** invite a seated/spectating human → they accept, leave their seat,
  and join. (Recruitment UI flow TBD in Phase 2.)
- **Loot:** total run gold is **split evenly** among all surviving party members on bail/victory.
- All recruited members vacate their seats and return to spectator when the run ends.

---

## Audio (muffled cross-feed)

- **In the dungeon:** poker SFX play at ~0.3× (distant, through the floor).
- **At the table:** dungeon combat SFX broadcast to the table room at low volume,
  so seated/spectating players hear muffled thumps from the basement.
- Built on the existing `playFromPool` volume scaling + a per-context damp factor.
- MVP: one-way (muffled poker heard in the dungeon) + a simple low-volume dungeon
  ambient; full bidirectional cross-feed in a later phase.

---

## Architecture / integration

- **`backend/src/game/Dungeon.js`** — one instance per active run (party). Tracks
  party, enemies, HP, turn order, depth, room state, run gold/loot, status. Mirrors
  `Table`: a `publicState()` + a `_broadcast()` to a `dungeon:<id>` Socket.IO room.
- **`backend/src/sockets/dungeon.js`** — `dungeon:enter`, `dungeon:action`
  (attack/spell/door/bail/equip/hock), `dungeon:recruit` (Phase 2), `dungeon:leave`.
- **Enter/leave seat** via existing `table.stand` / spectator handling. **Credit
  gold** via `db.setChips`; **loot** via `db.getGear`/`db.setGear`.
- **Combat** = new resolver reusing `combat.js` `resolveSwing`/`resolveSpell`, with
  real HP pools held in the Dungeon instance (never touching chips mid-run).
- **Frontend:** new `data-show-on="dungeon"` screen + `renderDungeon()` drawing a
  simplified Foundry-style overhead room (background tile, party + enemy tokens,
  the enemy's art), a combat log, and the action buttons. `setScreen('dungeon')`.
- **Concurrency:** each leader spawns their own Dungeon instance; multiple runs
  coexist. A human ally joins the leader's instance.

---

## Phased roadmap

**Phase 1 — Solo MVP (the build target now)**
- 🗡️ Hit the Dungeon button on the table → leave seat → dungeon screen.
- Endless room-crawl, menu combat (Attack / Lightning / Stinking / Open door / Bail).
- HP from gear; PF1e-ish to-hit/AC/damage via `combat.js`; spell cooldowns.
- Placeholder Ustalav encounter table + simple tile/token art.
- Gold (modest curve) + +1 loot (hock/equip); bail banks gold; death forfeits run gold + unbanked loot.
- Simplified VTT render + combat log; muffled poker audio one-way.

**Phase 2 — Party + bosses**
- Recruit AI allies (50g, leave seat, auto-fight, even split).
- AI-character mini-bosses (best-geared bots) as impeding bosses.

**Phase 3 — Polish**
- Human ally recruitment (invite/accept).
- Bidirectional muffled audio; richer/varied maps.
- Swap placeholders for real Foundry creatures, art, and dungeon maps.

---

## Confirmed micro-decisions

1. **AI-boss chips:** beating a best-geared AI mini-boss gives **dungeon loot only**
   — their actual poker chips are untouched (strict zero poker-economy impact).
2. **AFK / turn timer:** a generous per-turn timer; on timeout it **auto-Bails**
   (banks gold and exits safely) rather than risk an AFK death.
3. **Name:** button **"🗡️ Hit the Dungeon"**, screen titled **"The Dungeon."**

---

## Current implementation (as-built — 2026-06)

The MVP has grown into a full PF1e-flavoured combat side-game. Source of truth:
`backend/src/pf1data/abilities.js` (class kits), `backend/src/game/Dungeon.js`
(engine), `backend/src/pf1data/staples.js` (weapons), `backend/src/pf1data/xp.js`
(experience & leveling).

### Experience & leveling (`pf1data/xp.js`)
Level comes from **persisted XP** (`players.experience`), PF1 **medium track** —
NOT from gear. `levelFromXp(xp)` drives BAB / HP / saves / feats / spell slots;
gear (`weaponOf`/`acOf`) only adds to-hit / AC / damage.
- **Award:** at room-clear, `_awardRoomXp` grants `xpForCR(cr)` for each vanquished
  foe (× `XP_AWARD_MULT`, default 1.0), **split among members still in the run**
  (`!left && !dead` — alive OR downed). Persisted via `db.addXp`; `_applyLevelFromXp`
  applies level-ups (HP bump) and `_announceLevelUp` posts the BAB/HP/feat/spell gains.
- **Death (`_memberDown`):** `db.setXp(playerId, xpFloorForLevel(level − 1))` — back
  to the START of the previous level (a near-2-level loss if they were about to advance).
- **No-win wipe (`_runFailed` → `_loseAllGear`):** a total wipe, or a full retreat
  from an uncleared room with no one left to win it, zeroes every participant's `gear`
  (`db.setGear({})`) and drops pending loot. Clearing the room keeps the loot.
- Encounter budgeting uses `rawXpForCR` (un-multiplied) so room sizing is unaffected
  by `XP_AWARD_MULT`. Bots level identically (their XP persists too).
- **XP is per-class.** `db.getXp/addXp/setXp` key on the player's *current* class via a
  `players.class_xp` JSON map (mirrored to `experience` for the active class). Switch
  class and you start at that class's own level; switch back and the prior level returns.
  Gear is untouched by a class switch.
- **Full Wipe** (the table's 5,000gp reset) now also zeroes `experience` + `class_xp`,
  clears gear, and runs `db.resetChampions()` — a true fresh start including the Hall of
  Records.

### Armor-class types (`combat.js acOf`, `Dungeon._enemyAC`)
Monsters track **normal / touch / flat-footed AC**, surfaced on the monster tile.
- **Touch AC** = `base.touch || max(10, ac − 5)`; **flat-footed** = AC − 2.
- **Spells and firearms** resolve vs touch AC (`_enemyAC(e, {touch:true})`) — a ranged
  touch attack ignores armor + shield, so guns/rays connect far more often than steel.
- **Arcane casters wear no armor** (`acOf` `arcaneNoArmor` for wizard/sorcerer): they get
  only the *magic bonus* of owned armor (a "+1 chain shirt" = +1, not +4) and **never**
  benefit from a shield. They auto-cast **Mage Armor** at the start of each fight.

### Ability cost models
- **`free`** — martial maneuvers, usable every turn (Trip, Cleave, Feint, Rapid
  Shot, bard songs, paladin **Detect Evil**). Some are **free actions**
  (`freeAction: true`) that don't end the turn: barbarian **Rage**, inquisitor
  **Judgements** & **Bane**, paladin **Smite Evil**.
- **`room`** — own per-room use count; refreshes each room (paladin Channel; the
  inquisitor's **Bane** and paladin's **Smite** are room-counted but cost no
  action; every **prepared** wizard/druid spell at `uses:1`).
- **`slot`** — per-spell-level slots (`slotsFor`), refreshed each room: **cleric**,
  **bard**, **sorcerer**, and the **inquisitor** (spontaneous divine, slower
  6-level table).
- **`pool`** — legacy shared per-room cast pool (`spellSlots(level)`); unused now
  that the sorcerer is slot-based.
- **`run`** — once per WHOLE dungeon, never refreshed: **Bless**, bard **Inspire
  Courage**. Pairs with **`persist`** buffs stored in `m.runBuffs` (survive room
  resets).

### Casters
- **Wizard** — prepared; 1 cast of each spell/room. Shocking Grasp, Grease, Sleep,
  Invisibility, Acid Arrow, Scorching Ray, Hold Person, Dispel Magic, Haste,
  Fireball, Lightning Bolt, Cone of Cold, Disintegrate.
- **Sorcerer** — spontaneous; few known spells cast from per-level slots (Magic
  Missile, Burning Hands, Acid Arrow, Gust of Wind, Scorching Ray, Fireball, Cone
  of Cold, Disintegrate).
- **Cleric** — prepared; Cure Light/Moderate, Divine Favor, Holy Smite, Searing
  Light, Prayer, Bless, Channel Positive (½lvl d6, 1/5 levels/room), Boneshatter,
  **Breath of Life / Raise Dead / Resurrection** (level-gated revives).
- **Druid** — prepared; Entangle, Cure Light Wounds, Call Lightning.
- **Inquisitor** — spontaneous divine on a **slower 6-level** progression
  (`INQ_SLOTS_BY_LEVEL`); a curated cleric-list repertoire (Cure
  Light/Moderate/Serious/Critical, Shield of Faith, Divine Favor, Hold Person,
  Bull's Strength, Spiritual Weapon, Dispel Magic, Prayer, Searing Light, Holy
  Smite). Fights with steel alongside **Bane** + **Judgements**, and earns the
  fighter bonus-feat ladder at **half rate** (a feat every odd level).
- **Oracle** — spontaneous divine on the **cleric spell list** at full-caster
  progression (`slotsFor('oracle')` → SORC slot table). Built from a clone of the
  cleric kit (`KITS.oracle.abilities`) so the two stay in sync — including
  **Channel Positive** — plus **Haste**, **Slow**, and the Flame-mystery fire
  spells (Burning Hands, Scorching Ray, Fireball, Fire Snake). At-will: Produce
  Flame. Bots blast via the arcane-controller path (heals/buffs first, then the
  widest blast). Elfrip (Flame) leans on fire and shouts "BOOM!" on a big hit
  (`SIGNATURE_LINES`, `cast_fire` event); Rhyarca & Casandalee play the full kit.

### Spell math (full-PF1 casting stat)
Spells now assume an **18 casting stat** (matching attacks' assumed 18 Str/Dex): save
**DC = 10 + spell level + `CAST_MOD` (4)**, and casters gain **bonus 1st–4th level
slots** (`_tableSlots` adds +1 to spell levels 1–4 for the 18 stat).

### Notable mechanics
- **Scorching Ray** splits (1 ray, 2 at CL7, 3 at CL11) with a split sound.
- **Mage Armor** (`MAGE_ARMOR`) — wizards/sorcerers cast it free, run-long, at fight
  start; it's their substitute for worn armor.
- **Protection from Evil** (`SPELL.protevil`) — personal +2 AC / +2 saves ward.
- **Darkness** (`SPELL.darkness`) — blinds **1d4+1 foes** at once (`randBase:1
  randDie:4`); darkened enemies are excluded from `_targetableEnemies()` (can't be
  targeted or struck) until it lifts.
- **Dispel Magic** auto-targets: strips the **worst debuff on an ally**, or — if none —
  the **best buff on an enemy** (`_abCleanse`).
- **Mind-affecting immunity** — Sleep/Fascinate/Hold Person can't touch **undead or
  constructs** (`mindImmune`); a melee weapon **can't hit flyers** (need ranged/reach/
  spell).
- **Invisibility** — untargetable (`_targetableParty`) until you attack.
- **Haste** — party gets one extra attack next turn (`m.hasted`, `_hasteBonus`).
- **Inquisitor Judgements** — one active at a time (Destruction +dmg / Protection
  +AC / Healing regen), switched free and lasting the whole room.
- **Inquisitor Bane** — a free action that declares ONE **creature type**; +2
  to-hit / +2d6+2 damage **only vs that type** (`m.bane.type` vs `target.type`),
  until re-declared. 1 per 5 levels per room.
- **Creature types & alignment** — every monster carries a PF1 `type`
  (undead/humanoid/animal/giant/magical beast/aberration/construct/ooze/outsider)
  for Bane, and an `align` + derived `evil` flag for Smite.
- **Paladin Smite Evil** — a **free action**; +to-hit and +2×level damage, but
  **only vs evil-aligned foes**. **Detect Evil** (a standard action) sets
  `markedEvil` on every foe so Smite applies to all of them (even true-neutral
  animals/constructs); marked foes show a bullseye condition icon.
- **Sound pools** — abilities with `sounds:[...]` pick a random clip per cast
  (Fireball, Lightning Bolt, Haste).
- **Conditions** shown as PF1 icons: sickened, paralyzed, stunned, asleep, prone.
- **Signature weapons** (`staples.js` CUSTOM_WEAPONS) carry `atkSound`, plus
  `dual` (two swings/one report) + `noShield` (Farrus's twin axes).
- **Enemy specials**: shaman Hold Person, Skeletal Champion stun-shout, Lich/
  Vampire fear-gaze, Fire Skeleton death-explosion.

### Bot ability AI (`Dungeon._botAbility`)
Priority: revive fallen → dispel/heal the hurt → declare a judgement / **Bane** →
Smite → **Detect Evil** (when neutral foes are present) → raise buffs (once) →
group-blast → spell/maneuver at the weakest foe → basic attack.
Won't repeat the same ability twice in a row when alternatives exist.

### Leaving a run & poker/dungeon exclusivity
A delver has three ways out, all of which bank their split share via `bail()`:
- **👁 Spectate** (`dungeon:bailWatch`) — leave the fight, keep watching/heckling.
- **↩ Leave dungeon** (`dungeon:leave`) — bank and return to the poker table.
- **🛑 Cancel run** (`dungeon:cancel` → `Dungeon.cancelRun()`) — force-end the WHOLE
  run: every remaining member is bailed (each banks their share) and the run ends.
  A clean group retreat — **not** a wipe, so no gear is lost.

Gold splits an even share among everyone **not dead** (`!left && !dead`) — the
living and the *dying* (downed, hp ≤ 0 but not slain) get hauled out with their
cut, but a **SLAIN hero forfeits their share** (`bail()` pays a dead member 0).

**A player is never in both places at once.** Entering the dungeon vacates the
poker seat; conversely **sitting down at poker pulls the player out of any run**
(`table:sit` bails them). The poker table also **won't seat a bot that's currently
delving** (`sockets/table.js` `inAnyDungeon` guard), mirroring the dungeon's own
"don't recruit a seated bot" rule, and a human who has **taken over an AI character**
still counts as present (`anyHumanPresent` no longer filters on `is_bot`) so the
table keeps dealing. When the **last human leaves**, `bail()` lets the AI allies
finish the current room, then they cash out and the run ends.

### Paladin (home-rules)
- **Spellcasting from level 1** (not 4): Shield of Faith (1), Bull's Strength (4),
  Prayer (7), Blessing of Fervor (10) — one casting each per room.
- **Hero's Defiance** — a downed (not dead) paladin auto-heals on their turn
  (lay-on-hands, once/room) via `_tryHeroesDefiance`, fired from the turn loop.
- **Fighter-feat tree on odd levels** (`paladinFeats`): Toughness (1), Power Attack
  (3, the toggle), Weapon Focus (5), Dodge (7), Weapon Spec (9), Improved Init (11),
  a save feat (13), Improved Crit (15), Critical Focus (17), Improved Cleave (19).

### Haste vs Blessing of Fervor
- **Haste** (`key:'haste'`): the extra attack PLUS +1 to hit, +1 dodge AC, +1 Reflex
  (`_hasteMod`, gated on `hasted && hasteFull` — auto-ends with Haste, never
  self-stacks, stacks cross-type with other buffs).
- **Blessing of Fervor** (`key:'blessingoffervor'`): the haste **extra attack only**.
  Available to cleric / oracle / inquisitor / paladin; incants ABBA's "Gimme!" (3
  clips). Two extra-attack sources never stack the extra attack (`m.hasted` is set,
  not added).

### Compound interest
Abadar's loan (`rebuy_debt`) compounds +5%/10 turns played (poker actions AND
dungeon combat turns) while in debt — see `db.tickDebtTurn`.
