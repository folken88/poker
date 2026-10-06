# Questions for Toby — the standing ruling queue

One consolidated place (Josh's ask, 2026-08-29). Every open design/rules
question lives HERE, newest first. When Toby rules, the answer moves to the
Ruled section with the version that implemented it.

## Open

1. **Sound round 3 tail** — mage armor and shield still need their own buff
   sounds (Divine Favor / Divine Power / Greater Invisibility took the three
   invoker assets, 2026-08-31). More picks from the effects library welcome.

2. **Potion store port** — ruled yes earlier; Toby says "more on potion store
   soon" (2026-08-31). Awaiting his details before building.

3. **Lingering-storm adaptation (veto point)** — Josh asked whether Call
   Lightning should keep its book mechanic; v3.37.143 implements it with one
   adaptation: the per-round bolt is AUTO-CALLED free at the caster's turn
   start (RAW spends the caster's action to call each bolt). Rationale: in
   our format a turn spent on a 3d6 bolt is strictly worse than attacking,
   so RAW-strict would make the lingering storm dead weight. Veto or bless.

4. **Farrah's concept** (Josh, 2026-09-03) — the bench sorcerer has NO concept on
   file: characterBuilds carries only `race: human, flex: cha`, so she runs the
   generic sorcerer loadout (whose priority list includes Summon Monster IV/VI/VIII
   — hence the summoning Josh noticed). Olbryn and Gabriel have real concepts;
   should Farrah get one (bloodline, signature spells, weapon), and what is it?

5. **Pinned** (Josh's debuff audit) — our grapple renders a seized foe helpless,
   which is closer to PF1 "pinned" than "grappled." Keep the single tier, or split
   grappled (−2 hit/AC, no Dex) from pinned (helpless) at a second CMB check?

6. **The high-CR bestiary is thin** (Josh's monotony report, 2026-09-05) — the
   non-boss spawn pool holds 6 monsters in CR 14-18 and only 2 in CR 16-20 (one
   undead, one devil). v3.37.147 works around it (flat anchor, no-encore, band
   widening), but at level 19-20 variety needs more CR 16-20 monsters — a Foundry
   import job (which families: dragons? giants? the Boali way?).

7. **Play styles for the rest of the roster** (Josh, 2026-09-06) — v3.37.149 gave
   characterBuilds a `style` the bot brain reads: 'summoner' (Jason, Draymus),
   'guardian' (Dinvaya), 'storm' (Olbryn). Josh's point: "I want Gaspar to play
   like Gaspar whether I'm running him or the AI is." Which of your characters
   (Taboon, Ramos, Gaspar, the rest) get a style, and what is it? New styles are
   cheap to add if a concept needs one (e.g. 'blaster', 'controller', 'necromancer').


14. **Bloodline translations** (v3.37.169-170 shipped stand-ins; each power's desc names them). Bless or
    redirect: (a) **Claws** (abyssal/draconic) — today +damage on your weapon strikes for the room; the
    book gives two real 1d4/1d6 claw attacks. Real natural attacks instead? (b) **Corrupting Touch /
    Grave Touch** (infernal/undead) — today a no-save touch that shakes; the book has no save either but
    a touch ATTACK. Keep the auto-hit? (c) **Heavenly Fire** (celestial) — today a ray that damages any
    foe; the book heals good creatures, damages evil, does nothing to neutral. Alignment-gate it? (d)
    **Fated** (destined) — today an always-on luck bonus to AC/saves; the book gives it only in the
    first round of combat (surprise rounds). Always-on OK? (e) **Touch of Destiny** (destined 1) and
    **Laughing Touch** (fey 1) — no engine hook yet. Proposed: Touch of Destiny = one ally gets +½ level
    on their next attack roll and save (a swift); Laughing Touch = one foe loses its next move/attack
    (Will negates, mind-affecting) — i.e. a 1-round 'slowed'. (f) **Arcane bloodline** meta powers —
    proposed: Arcane Bond = once a dungeon, recover one spent casting; Metamagic Adept = N free
    Empower/Maximize applications a room (N = 1 at 3, +1 per 4 levels); School Power = +2 DC on one
    spell school you pick in the lobby; Arcane Apotheosis (20) = metamagic never raises the slot. (g)
    **Draconic colours** — one pick 'draconic' with an element dropdown (acid/cold/electricity/fire), or
    ten separate bloodline entries? (h) **Farrah's bloodline** (ties to #4). (i) **Bloodrager ladder** —
    bloodragers get powers at the sorcerer levels (1/3/9/15/20) as a stopgap; the ACG bloodrager ladder
    is 1/4/8/12/16/20 with DIFFERENT powers. Keep the stopgap, or build the ACG bloodrager bloodlines
    as their own table?

15. **CRB leftovers** (found 2026-09-29 — the v3.37.162 'queue empty' was wrong; batches 13-16 are
    queued in the CRB ledger). Three need a ruling: **Antimagic Field** (Clr 8, Sor/Wiz 6) — it would
    strip the party's own buffs and summons too; ship it as 'no spells either side for the room' or
    🚫? **Contingency** (Sor/Wiz 6) — 'when X happens, Y fires'; proposed 🚫 (no trigger surface) or a
    single pre-set 'when I drop below half HP, a stored cure fires'. **Mage's Faithful Hound** (Sor/Wiz
    5) — proposed 🚫, or a room-long summon that only bites foes attacking the caster and ignores
    invisibility.

16. **APG/UM scope** (batch A1 shipped in v3.37.175 — Ear-Piercing Scream, Frigid Touch, Stone Call,
    Sirocco, Cleanse). (a) Priority: fill the THIN lists first (magus/UM, inquisitor and oracle/APG,
    bloodrager/ACG) or the big Sor/Wiz blasts and controls? (b) Adaptations used in A1 — bless or veto:
    dazed → the engine's stunned (turn lost); staggered → the engine's slowed (one action); Sirocco's
    fatigue lasts the room; a Sirocco'd flyer is prone and reachable until it stands, then flies again.
    (c) Is the ACG (Advanced Class Guide) list in scope too, or APG + UM only? (d) Heroes are never
    fatigued, poisoned or drained, so the APG/UM cure spells for those stay 🚫 like their CRB cousins —
    unless you want those conditions to start landing on heroes.

17. **The flying party and the grounded dungeon** (Josh, 2026-10-05: 'do enemy casters not carry fly spells
    or debuff spells? if my party all gets flying we can steamroll… is this by design?'). Numbers from his
    seven runs of 10-04..10-06: **553 enemy swings at the air** (gentle-noodle 178 in 39 rounds, fuzzy-
    penguin 215 in 56). The enemy repertoire today: Hold Person casters (shamans, the Thought Harvester);
    arcane bosses by caster level — Mirror Image (CL4), Fly for THEMSELVES when melee-swarmed (CL5),
    Invisibility (CL3), Bestow Curse (CL5, once a room), Dispel Magic (CL9, 1-in-4, once a room, only on a
    hero wearing 3+ buffs), Fireball/Cone/Chain artillery; archers only via RANGED_KEYS; no melee monster
    has a ranged fallback. Your 09-23 ruling was 'if their buffs trivialize a room, so be it'. Josh now asks
    for danger back ('danger of being blown away is the fun bit'). Options, any mix: (a) humanoid melee
    foes carry a sidearm — a javelin/sling/thrown-axe shot at −4 when nothing is in reach (PF1 stat blocks
    nearly always list one); (b) anti-air doctrine for casters — when the whole party is airborne, Dispel
    the flyer first (any CL that has the spell), or Glitterdust/Web the squishiest; (c) spawn weighting —
    when the party enters a room flying, bias the band toward flying and ranged foes; (d) leave it.

18. **+5 gear on a level-1 character** (Josh's 'are the bad boys being nerfed?', 2026-10-05). No nerfs in
    the code. His gunslinger re-rolled at level 1 wearing the saved +5 weapon/armor/shield/cloak/ring
    (gear persists across re-rolls and the level-the-field drop by design), so at L1-8 foes hit him and
    the levelled-down allies **5-8%** of the time (merry-walrus 17 hits in 328 swings); by L13-16 it is
    28-37%, which is close to PF1 norms. Guns themselves are by the book: touch AC in the first increment
    → 97% hits; the 25-damage shots are 1d12 + Dex + 5 enhancement + Deadly Aim + Up Close dice. Keep gear
    unbounded (his call to re-roll), or cap the usable enhancement by level (e.g. +1 per 3 levels)?

## Standing policy (Toby)

- **Bonus typing** (2026-08-30): same-type bonuses never stack; categorize
  correctly instead (item = its crafting spell's type; racial stacks with
  enhancement).
- **PF1 first:** "pf1 rules always to start with, then deviate when we have to."
- **Bot variety** (2026-08-31): strong tactical options (haste-first) should
  weigh heavily but carry "a little rng" when multiple good paths exist.

## Ruled

- **Fatigue tiers per PF1** (no ruling needed — PF1-first): exhausted = Str/Dex −6
  (−3 hit/damage/AC/Reflex) with STAGGERED standing in for the half-speed rider our
  format lacks; fatigued = −2 (−1 each); Ray of Exhaustion Fortitude-partial; Waves
  of Fatigue imported — v3.37.145.
- **Buff sounds delivered** (2026-08-31): Toby's invoker set — Divine Favor =
  invoke.mp3, Divine Power = Invoker_Alacrity.mp3, Greater Invisibility =
  invoker_ghost_walk.mp3 — v3.37.141.
- **Paladin home rules stamped** (2026-08-31): Blessing of Fervor and Shield
  of Faith STAY on the paladin ("this is a home rule"); Hero's Defiance stays.
  Descs carry the home-rule tag — v3.37.141.
- **The Speed Race blessed** (2026-08-31): haste-first vs big/caster-heavy
  fields confirmed, weighted 4-in-5 with re-rolls — v3.37.140/.141.
- **The WALL mechanic** (2026-08-31, for CRB batch 2 — Wall of Fire/Ice/Force,
  Web, Solid Fog): a standing wall prevents the party from being flanked or
  sneak-attacked and caps melee attackers at TWO per target per turn ("six
  goblin rogues attack; you put up a wall; only 2 may attack the same
  target"). SHIPPED as CRB batch 2 — v3.37.146.
- **Divine Favor + Divine Power don't stack** (both luck) — v3.37.135.
- **Martial casters get PF1 spell lists on the PF1 ladder** — v3.37.136;
  Holy Sword (book paladin 4) added v3.37.140.
- **Stoneskin (Communal) room-only; solo dungeon-long** — v3.37.136.
- **Spiritual Weapon + Ally side by side, riding caster buffs; ally = angel;
  spirits use the caster's senses and favor the caster's target** —
  v3.37.136/.137.
- **Extract sound = tarkov_stim.mp3** — v3.37.136.
- **Enemy CR cap ≤ highest hero level +2** — v3.37.121.
- **Ranged heroes get backup melee; melee get backup crossbows** — v3.37.121.
- **Dimension Door / Teleport tactics; teleport = 2 rounds safe harbor** — v3.37.123.
- **10-min/level+ buffs last the whole dungeon** — v3.37.123.
- **Time Stop 1d4+1 free castings; Wish defaults; summons = simpler versions
  of existing monsters; more druid forms** — v3.37.125.
- **CRB parity ground rules** — 2026-08-26; ledger in docs/CRB-SPELL-PARITY.md.
- **Holy Smite / Unholy Blight follow the PF1 alignment table** (opposed full, neutral half,
  same-aligned nothing) — 2026-09-23, v3.37.170.
- **Gabriel is a bloodrager** (multiclassed bloodrager/paladin on the sheet; full bloodrager
  levels until multiclassing exists) — 2026-09-23, v3.37.170.
- **The slow casters (paladin, antipaladin, ranger, bloodrager) cast 1st-level spells from
  level 1; the rest of the ladder stays slow; the bloodrager list grows (ACG)** — 2026-09-23, v3.37.170.
- **Bloodragers pick sorcerer bloodlines too** (the sorcerer ladder stands in for the ACG one; a
  picked bloodline replaces the generic Surge) — 2026-09-23, v3.37.170.
- **Bot doctrine = weighted RNG per role** (support caster ~40/30/30 buff/control/attack; fighter
  100% attack; 70/30 attack/dispel for a Bujon type; Celeb prepares buffs + control + dispels + a
  rare attack, best buff first, burns Spell Synthesis whenever it is up) — 2026-09-23, v3.37.171.
