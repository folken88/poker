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

8. **Holy Smite / Unholy Blight and the alignment table** (v3.37.160). Chaos Hammer and
   Order's Wrath now follow PF1: opposed foes take full, neutral half, same-aligned nothing.
   Holy Smite and Unholy Blight predate that and still hit every foe for full. RAW they
   should follow the same table (Unholy Blight would then do nothing to the evil foes that
   fill most rooms — Draymus's bot casts it). Keep them as-is for fun, or go RAW?

9. **Gabriel's class** (Josh, 2026-09-21: 'Gabriel is a Bloodrager not a Paladin btw'). The roster
   pins him as an aasimar PALADIN (the Redeemer, smite, lay on hands). Is Josh right about the
   tabletop sheet? If yes, say so and he is re-pinned — but he loses the paladin kit the bot plays.

10. **Celeb's default loadout** (Josh, run cozy-muffin: 'I ain't sure Celeb is loaded out right… ask
   Toby what he should carry by default'). Facts: the theurge has NO prep sheet — every spell in his
   dual kit is castable, gated only by level and the split arcane/divine slots. In that run he cast
   Haste ×12, Slow ×9, Fly ×7, Dimension Door ×7, Grease ×5, Blessing of Fervor ×5 and one each of
   ~20 others. Do you want a curated default list for him (and should he prepare like a wizard)?

11. **Bloodline Surge** (Josh, 2026-09-21: 'I cannot find any reference to the bloodline surge power').
   He is right — it is a home stand-in, not a book power: +1 hit / +3 damage / +2 AC, once a room,
   from level 4. The book gives a bloodrager a BLOODLINE with its own powers at 1/4/8/12/16/20. The
   desc now says so. Build real bloodlines (which ones first?) or keep the generic surge?

12. **The bloodrager's spell model.** Book: spontaneous, Cha-based, its own spells-per-day table
   from level 4 and a spells-known table. Engine: a fixed list, each spell once per room (your
   2026-08-30 ruling for the martial 4-level casters; paladin/ranger have since moved to real slot
   tables). Move the bloodrager to slots + spells known too?

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
