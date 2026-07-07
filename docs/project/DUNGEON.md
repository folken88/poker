# Dungeon (game/Dungeon.js + game/dungeon/* mixins)

Since the Phase-2 split (2026-07-04, extended by the summons + heroAI seams on
2026-07-07) the engine is one class spread over seven files: `Dungeon.js` (core:
constructor, rooms, turn loop, action router, party/exits, `_swingVsAC`/`_makeEnemy`)
plus `game/dungeon/{abilities,enemyAI,heroAI,summons,serialize,loot}.js` grafted
onto the prototype via `Object.assign` factories at the bottom of Dungeon.js. The
hero-bot AI (`_allyAct`/`_botAbility`/…) now lives in `heroAI.js` (the mirror of
`enemyAI.js`); the summon builders (`_abSummon`/`_enemySummon`) in `summons.js`. `this`
semantics are identical — mixins cross-call freely. A mixin that needs a
Dungeon module-scope const receives it as a FACTORY PARAM (never reach for a
global you weren't handed — see CLAUDE.md mandate 9, the BUFF_META lesson).

One shared co-op run per table. Leave your poker seat ("Hit the Dungeon"),
descend room by room, fight PF1-flavored monsters, haul gold back up. Gold =
chips 1:1. XP is real and persistent (`levelFromXp`); levels never come from gear.

## Run loop

`_spawnRoom` builds encounters from an XP budget geared to the weakest hero;
party size multiplies the monster count. Every `BOSS_EVERY` depths is a boss
room (one strong foe + minions). Rooms: combat → clear (gold + XP split EVENLY
among all non-left allies, dead-but-revivable included) → loot roll (R/P d20,
auto-pass on equal-or-better, losers' would-be items hocked into the pool) →
door (deeper) or bail (bank your even share). Death at −10: gear loss only for
heroes who DIED in a failed run; bail/flee/disconnect always keeps gear.
Reload drops you back INTO your run (3-minute reconnect grace, then auto-bail
with your share). Run cancel: period key (blind) / session menu, confirm.
**SIGTERM banks every active run's pool to the party before the process exits**
(deploys can't eat gold). **A hard CRASH also banks it**: `server.js` has
`uncaughtException`/`unhandledRejection` handlers that run `_groupExtract` on
every live run before exiting (a loot-roll timer once threw on a null
`lootRoll`, crashed the process, and docker-restart vaporized a depth-15 run +
12,893 gp — the SIGTERM path doesn't fire on a crash, so this backstop does).

**Action queue**: a human may pick an action BEFORE their turn — it pre-loads
(⏳ chip on the card) and fires when the turn comes; re-picking replaces it.
Wiped by death/dying/acting-live/room change; a fizzle hands the turn back live.
The blind E-lock rides the same queue.

**AI flees with the party**: when a CONSCIOUS human voluntarily flees mid-fight
and no conscious human remains to lead, the hired AI break and run too (each
bails on its next turn). A human re-joining or a new room calls it off
(`_fleeing`).

## PF1 systems implemented

- **Characters**: 25-pt buy ability scores per class profile; HD/BAB/saves from
  `classes.js`; `deriveCharacter` HP; real weapon math (`attackProfile`):
  STR/DEX, finesse (incl. finesse2h elven curved blade), 2-handed ×1.5, offhand
  ½-mod, TWF penalties, iteratives at BAB 6/11/16, Rapid Shot/Manyshot.
- **Action economy (the no-grid shortcuts)**: melee engaging a NEW target =
  move + standard (ONE attack); staying on the same target next turn = FULL
  ATTACK (iteratives / full natural routine). Applies to heroes
  (`_attackOffsets`) AND enemies (`_enemyAct`, `e._lastAtkTarget`). Ranged
  always full-attacks. Spells/specials = standard actions; Power Attack/Deadly
  Aim/Rage/Judgement = free; Quickened casts = swift (one per turn, acts again).
- **Proficiency**: uniform for all combatants (no AI exemption); `custom:`
  signature weapons always proficient; non-proficient = −4.
- **Damage types & DR**: S/P/B vs `dr {amount, bypass}` (B for skeletons, S for
  zombies, magic for gargoyles/vampires, `—`/numeric = Stoneskin-like);
  energy `resist` multipliers (0 immune, 0.5 resist, 1.5 vulnerable); undead
  cold+poison immunity is type-driven. Every hit line shows the `−N DR` soak;
  first hit per creature type announces its DR; the blind E-inspector speaks it.
- **Conditions**: held/paralyzed (re-save each turn, costs the turn), stunned,
  sickened, blinded (glitterdust), prone/trip (PF1 legs/size rules), fascinated/
  asleep (broken by hits), grappled (constrict, Grease/Dispel frees), slowed,
  darkness (can't act/be targeted — unless the party has Darkvision Communal),
  fear shouts, ferocity (orcs fight to −10). **Standing from prone is a MOVE
  action**: a prone enemy that stands keeps its standard (one attack if it stays
  on its target, none if it must close on a new one); a slowed/staggered foe
  spends its single action just standing. **Flying creatures can't be knocked
  prone** anywhere (trip gate, mass-prone saves, dispel-Fly grounds them first).
- **Magus**: gains NO AC from a physical shield (off hand = spell combat); the
  Shield SPELL still works. (Swashbucklers + arcane casters also get no shield AC.)
- **Metamagic**: spontaneous casters get pre-cast toggles (Intensify/Empower/
  Maximize/Quicken) that re-level the slot, PF1 RAW stacking; prepared casters
  get designer entries (Quickened Magic Missile, Intensified/Empowered
  Fireball…). Bots use Empower/Maximize with surplus slots.
- **Dispel Magic**: real dispel check (d20+CL vs 11+CL), strips ally debuffs or
  foe buffs — including boss pre-cast wards (one per cast; Greater sweeps all;
  dispelling Fly drops the boss prone). Failure plays the vine boom. **Targetable
  by humans**: pick a specific afflicted ally OR enchanted foe (sighted: party-
  card / enemy click; blind: a combined ally+foe picker, Return = smart auto).
  No pick → smart auto-cast; REFUSES (slot kept, reason spoken) when the picked
  target — or the whole battle — has nothing to dispel.
- **Targeted ally spells** (`_pickedAlly`): Invisibility (+Greater), single Cure
  X Wounds, Infernal Healing, and Breath of Life honor a chosen ally (sighted
  party-card click → `allyUid`; blind ally-picker), else smart auto-pick. Kit
  state flags these `allyPick`; sticky single-ally buffs refuse a re-cast on an
  ally who already has them.
- **Protection from Fire**: PF1 absorption pool (12/CL, max 120), soaks after
  saves, both for heroes (`_fireSoak`) and warded bosses (`fireWard`).

## Classes (all 17 selectable, all with kits + feat trees)

fighter (two 20-feat ladders: melee + ranged), barbarian (rage, cleave chains),
ranger, rogue (sneak attack vs denied-Dex, Offensive Defense), paladin (smite,
Divine Bond auto-enchant +1@5→+6@20, holy +2d6 vs evil @8), antipaladin
(Fiendish Boon, Touch of Corruption, Vampiric Touch), cleric, wizard, sorcerer,
magus (spellstrikes, arcane pool enchant, mirror image/displacement), inquisitor
(judgements + bane; AI fights with steel, holds only boss-grade foes), bard,
druid (wild shapes, Reincarnate @7), oracle (spellbook; **mysteries**: Flame=Elfrip fire,
Time=Casandalee haste/slow/mirror image/displacement, Trickery=Rhyarca
invis/greater invis/darkness/Darkvision Communal), monk (flurry, stunning fist),
swashbuckler (parry/riposte, precise strike), gunslinger (firearms vs touch AC).

Cantrip at-wills (Ray of Frost/Acid Splash/Jolt) cycle with C; the at-will
button wears the chosen cantrip's name. Spiritual Weapon takes the shape of the
caster's deity's weapon (Rhyarca rapier, Elfrip scimitar, Dinvaya battleaxe,
Vesorianna whip; others their own). Melee characters auto-draw a backup light
crossbow when all foes fly.

## Monsters (`MON`)

CR 1/4 → 16: goblinoids/undead early; ogres, harpies, gargoyles, golems mid;
vampire court (rogue/knight/priest classed vampires), devils (barbed = hook +
hellfire; **Bomb Devil = alchemist of its HD** — 6d6+4 grenades, 6-bomb satchel,
throws on sight, real grenade SFX), dragons (breath via hellfire cfg with
element + verb), liches (full wizard AI: Hold Monster, blasts, Disintegrate/
Finger of Death prioritizing the party's caster, Magic Missile finisher),
named villains (Zernibeth W14, Abrogail S17, Barzillai).

**Boss designation**: +1d4 advancement levels (+12% HP & +1 to-hit per level;
AC/saves/damage/DCs/uses +1 per 2; CR +1 per 2 → more XP/loot; +25% gold per
level; name shows it, e.g. "Boss: Zernibeth +3") and **pre-cast long-duration
wards** for caster bosses (Mage Armor, Shield incl. Magic-Missile immunity,
Stoneskin, fire ward, Fly, Shield of Faith) — shown as chips with real buff
icons, dispellable.

**Enemy AI**: priest-types heal their most-wounded ally below half (profane
flavor for undead); wounded vampires spam their draining spellstrike; shamans
Hold Person the unheld; eager bombers bomb; taunts pull AI heroes; enemies use
the same flying-reach rules as heroes.

**Gang encounters** (`MON_GANGS`): the FIRST creature picked sets the room's
theme; the rest fill from the same gang — undead court, goblinoid + kobold
warrens (with kennel vermin), beasts, horrors (minotaur/chimera/medusa/oozes/
mouthers), giants, constructs, devils (+ Thrune villains), dragons (served by
kobolds). Multi-gang monsters anchor ONE at random (ogre = goblinoid OR giant);
unlisted = wildcard; the filter falls back to the full roster before a room
under-fills. Creature TYPES are correct for Bane (devils = outsider, dragons =
dragon, the basic undead carry `type:'undead'` so they're mind/cold/poison-immune).

**The Whispering Way** (`ww_*`): 9 classed LIVING cultists (clerics, rogues,
magi with lifesteal spellstrikes, wizards up to a W12 Archnecromancer) riding
the undead gang — mind spells land on them, channel positive doesn't sear them.

**Monks** (`monk_*`): 10 named martial artists (CR ≈ level−1), flurry + Evasion
+ kiai SFX — Shaolin (L5), Shackles Brawler (L6 Chelish, LE), Greenbriar Adept
(L8 orc), Chelish Redactor ×2 (L9/L10, LE), Vakra (L11), Beastmode (L15 orc,
2d6+10), Puff (goblin gang), Kobold Monk + Kobold Adept (kobold gang). Replaced
the old random-faced generic Monk.

**Card art**: every token has a paired full-art PORTRAIT in `public/portraits/`
(paired by content-hash from the Foundry `token_*` siblings, see
`tools/pair_portraits.sh` + `portraits/manifest.json`). Hero/villain cards use
it as a dimmed cover BACKGROUND (client `portraitFor`/`has-portrait`); the small
token is hidden when a portrait exists, kept when it doesn't. Transparent PNGs
sit on a dark-grey card fill.

## Ally caster AI (`_botAbility` doctrine — in `game/dungeon/heroAI.js`)

Decision order for bot casters, per turn:

1. **Breath of Life** on a DYING ally (below 0, not dead) — always #1.
   The already-DEAD are a non-factor mid-round (see end-of-round raises).
2. **Healing by severity**: ally below 30% → heal jumps the queue right here.
   Mild scrapes (<55-60%) wait until step 5. Nobody hurt → healers don't heal.
   Undead heroes (Tar Baphon, Vrood, Vesorianna, Farrus) take nothing from
   positive energy — healers reach for Infernal Healing on them (eagerly),
   Adimarus mends them with Channel Negative.
3. **CR calculus**: if the highest enemy CR is BELOW the caster's level the
   fight is chaff — skip wards/control/save-or-suck; throw Haste if the party's
   speed is dry, else just blast biggest-first until the damage spells run out.
4. **Control → buffs** (serious fights): Black Tentacles grips a pack, Slow
   staggers a crowd of 2+, the bard pins a boss with Hideous Laughter — all
   BEFORE the buff checklist. Then buffs, on a **round-decay appetite**
   (R1 ~90%, R2 ~60%, R3 ~30%, R4+ never) with a **potency floor**: a leveled
   buff needs slvl ≥ min(3, best castable − 3), so a L12 wizard opens Stoneskin
   (Communal)/Displacement/Haste and never casts Shield; low-level casters keep
   Shield/Bless. Sticky buffs sort most-potent-first. Haste/Fervor never double.
5. **Mild-wounds stop** — patch the party up before opening fire.
6. **Offense**: controllers (wizard/sorcerer/oracle) pick by coverage, spike a
   lone boss with their hardest nuke or Hold; everyone else cycles spells/
   maneuvers, avoiding last turn's pick. Blast ranking counts dice honestly
   ('halflevel' at lvl/2, damage caps respected).

**Front-loaded blasters** (`BLASTER_OPENERS`, currently Elfrip): on round 1 vs
foes of their level or weaker, 65% chance to skip everything and open with the
biggest blast (Fire Snake), hoping to end the fight before buffs matter.

**End-of-round raises**: when a round turns with a dead party member, a healer
holding Raise Dead/Resurrection performs the ritual between turns (revive
sound plays) so the fallen stand again next round (`_endOfRoundRaise`;
`_roundRaise` flag lets it through the in-combat ritual block). Inquisitors
fight with steel; magi are gishes — neither follows the robe-wearer doctrine.

**Druid Reincarnate** (4th-level, druid 7, once/room): the druid's raise-dead.
The soul returns in a NEW body — a fallen BOT hero is replaced by a random
hero from the bench (not seated at poker, not in the dungeon — the recruiter's
availability filter), arriving at full health as themselves. Dead humans and
an empty bench fall back to a plain raise.

**Invisible sneak-class allies STRIKE** (`SNEAK_CLASSES`: rogue/ninja/slayer):
an unseen attacker denies Dex, so an invisible rogue doesn't lurk — it alpha-
strikes the juiciest prey (enemy caster > boss > lowest HP). Normal Invisibility
breaks on the hit; Greater stays. Non-sneak invisible allies hold and SAY why
(blind-narrated). Every dungeon action error is spoken in blind mode.

## Recruiting

Unseated bots are mercenaries: fee = 50g + 10g × level, paid to the ally.
Picker shows class + fee; "🎲 Random helpers" fills affordable slots;
"↻ Last party" re-hires this browser's previous crew (localStorage, max 3).

## Blind support (dungeon)

Numbers = action list (1 attack, then features, then Spellbook sub-mode);
0 = door; B = bail; `.` = cancel (press twice); E = enemy inspector (HP, CR,
flying, DR, conditions, wards); M = run pool + depth; L = my HP; H = party HP;
C = cantrip; Esc = session menu; `?` = help mode (describes keys, never fires).
Narrator speaks every fresh log line (cap 8 + "skipping N"); flurries and
cleaves are aggregated into single lines server-side.

**Targeting sub-modes**: an ally-targeted spell prompts "on whom?" with a
numbered party list (Return = smart auto); Dispel prompts a combined
afflicted-ally + enchanted-foe list. Action queue: picking off-turn pre-loads;
the E-lock fires the attack when the turn comes.
