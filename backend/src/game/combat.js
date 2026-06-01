/**
 * "Useless fight" resolver — PURELY COSMETIC FLAVOR.
 *
 * This NEVER touches chips, stacks, pots, or standing. The poker game is a
 * poker game; this is a D&D/PF1e-flavored side gag where a seated player
 * can swing a weapon at another for a sound effect and a chat line.
 *
 * It reads a player's purchased gear (the same weapon/armor/shield/ring
 * slots used by the economy, tiers 1–5) and derives attack/AC numbers:
 *
 *   Weapon: no weapon slot  → Masterwork Dagger (1d4, +1 to-hit, +0 dmg)
 *           weapon tier N    → +N Longsword       (1d8, +N to-hit & dmg)
 *   AC = 10 + Full Plate(9+N) + Heavy Steel Shield(2+N) + Ring of Protection(+N),
 *        each counted only if that slot is owned (tier ≥ 1).
 *
 * Outcome is a 3-way split so armor feels real:
 *   - flesh  : total ≥ AC (or natural 20) → damage rolled, "eviscerate" sounds
 *   - blocked: the blow landed but armor/shield ate it → "clang/parry" sounds
 *   - whiff  : didn't even connect → swing/whoosh (dagger vs sword) sounds
 */

function dRoll(sides) { return 1 + Math.floor(Math.random() * sides); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Sound pools — files copied from the FoundryVTT effects library into
// public/audio/ (served by nginx at /audio/...).
const SND = {
  whiffDagger: '/audio/fight_whiff_dagger.mp3',
  whiffSword: ['/audio/fight_whiff_sword_1.mp3', '/audio/fight_whiff_sword_2.mp3', '/audio/fight_whiff_sword_3.mp3', '/audio/fight_whiff_sword_4.mp3', '/audio/fight_whiff_sword_5.mp3', '/audio/fight_whiff_sword_6.mp3', '/audio/fight_whiff_sword_7.mp3', '/audio/fight_whiff_sword_8.mp3'],
  block: ['/audio/fight_block_1.mp3', '/audio/fight_block_2.mp3', '/audio/fight_block_3.mp3', '/audio/fight_block_4.mp3', '/audio/fight_block_5.mp3', '/audio/fight_block_6.mp3', '/audio/fight_block_7.mp3', '/audio/fight_block_8.mp3', '/audio/fight_block_9.mp3', '/audio/fight_block_10.mp3', '/audio/fight_block_11.mp3'],
  // Clean sword/meaty impacts only. The dramatic, layered "eviscerate-spirit/
  // -flaming", "smack-anime" and "smack-holy" clips (old 14/15/16/20/22) were
  // pulled — those are the vocal "yell"-type sounds.
  flesh: ['/audio/fight_flesh_1.mp3', '/audio/fight_flesh_2.mp3', '/audio/fight_flesh_3.mp3', '/audio/fight_flesh_4.mp3', '/audio/fight_flesh_5.mp3', '/audio/fight_flesh_6.mp3', '/audio/fight_flesh_7.mp3', '/audio/fight_flesh_8.mp3', '/audio/fight_flesh_9.mp3', '/audio/fight_flesh_10.mp3', '/audio/fight_flesh_11.mp3', '/audio/fight_flesh_12.mp3', '/audio/fight_flesh_13.mp3', '/audio/fight_flesh_17.mp3', '/audio/fight_flesh_18.mp3', '/audio/fight_flesh_19.mp3', '/audio/fight_flesh_21.mp3', '/audio/fight_flesh_23.mp3'],
  fumble: '/audio/fight_fumble.mp3', // natural 1 — Roblox "oof" death sound
  // Lightning Bolt — a pool of thunderclaps / zaps / charge-ups so the
  // spell doesn't sound the same every cast. One is picked at random.
  lightning: [
    '/audio/fight_lightning.mp3',    // long slow thunderclap (original)
    '/audio/fight_lightning_2.mp3',  // direct thunderclap
    '/audio/fight_lightning_3.mp3',  // direct thunderclap
    '/audio/fight_lightning_4.mp3',  // direct thunderclap
    '/audio/fight_lightning_5.mp3',  // Mjolnir thunderclap
    '/audio/fight_lightning_7.mp3',  // lightning charge-up
    '/audio/fight_lightning_8.mp3',  // arcane umbral bolt
  ],
  // Stinking Cloud — a whole bouquet of farts, picked at random.
  stink: [
    '/audio/fight_stink.mp3',        // a juicy fart (original)
    '/audio/fight_stink_2.mp3',      // gorilla farts
    '/audio/fight_stink_3.mp3',      // classic fart
    '/audio/fight_stink_4.mp3',      // juicy fart
    '/audio/fight_stink_5.mp3',      // squeaky lock fart
    '/audio/fight_stink_6.mp3',      // release fart
    '/audio/fight_stink_7.mp3',      // fart shot
    '/audio/fight_stink_8.mp3',      // swoosh fart
  ],
};

/** Sum of every magic enhancement the caster owns (weapon + armor + shield
 *  + cloak + ring tiers). Drives spell DC and Lightning Bolt dice. */
function totalMagicBonus(gear) {
  if (!gear) return 0;
  let t = 0;
  for (const k of ['weapon', 'armor', 'shield', 'ring', 'cloak']) t += Number(gear[k]) || 0;
  return t;
}

/** Derive weapon stats from a gear object ({ weapon: tier, ... } or null). */
function weaponOf(gear) {
  const tier = (gear && Number(gear.weapon)) || 0;
  // Longsword & Dagger both threaten a crit on 19–20 and deal ×2 (PF1e).
  if (tier >= 1) {
    return { name: `+${tier} Longsword`, isDagger: false, toHit: tier, dmgDie: 8, dmgBonus: tier, critRange: 19, critMult: 2 };
  }
  return { name: 'Masterwork Dagger', isDagger: true, toHit: 1, dmgDie: 4, dmgBonus: 0, critRange: 19, critMult: 2 };
}

/** Derive Armor Class from a gear object. `physical` is the armor+shield
 *  portion — the part that CLANGS (distinguishes a blocked hit from a whiff).
 *  Ring of Protection is deflection: it raises AC but isn't a physical block. */
function acOf(gear) {
  let ac = 10, physical = 0;
  if (gear) {
    const armor = Number(gear.armor) || 0;
    const shield = Number(gear.shield) || 0;
    const ring = Number(gear.ring) || 0;
    if (armor >= 1)  { const v = 9 + armor;  ac += v; physical += v; }
    if (shield >= 1) { const v = 2 + shield; ac += v; physical += v; }
    if (ring >= 1)   { ac += ring; }
  }
  return { ac, physical };
}

/** Resolve a single swing of attackerGear against defenderGear.
 *  Returns everything the caller needs to narrate + play a sound. */
function resolveSwing(attackerGear, defenderGear) {
  const weapon = weaponOf(attackerGear);
  const { ac, physical } = acOf(defenderGear);
  const roll = dRoll(20);
  const total = roll + weapon.toHit;
  const fumble = roll === 1;   // natural 1: auto-miss (the "oof")

  let outcome, damage = 0, sound;
  let crit = false, threat = false, confirmRoll = 0, confirmTotal = 0;

  if (fumble) {
    outcome = 'fumble';
    sound = SND.fumble;
  } else if (roll === 20 || total >= ac) {   // natural 20 always hits
    outcome = 'flesh';
    const base = dRoll(weapon.dmgDie) + weapon.dmgBonus;
    // Pathfinder crit: a roll in the threat range (19–20) is a THREAT —
    // roll a second d20 + attack bonus to CONFIRM against the same AC.
    // Confirmed → ×critMult damage; unconfirmed → just a normal hit.
    if (roll >= weapon.critRange) {
      threat = true;
      confirmRoll = dRoll(20);
      confirmTotal = confirmRoll + weapon.toHit;
      crit = (confirmRoll === 20) || (confirmTotal >= ac);
    }
    damage = crit ? base * weapon.critMult : base;
    sound = pick(SND.flesh);
  } else if (physical > 0 && total >= ac - physical) {
    outcome = 'blocked';
    sound = pick(SND.block);
  } else {
    outcome = 'whiff';
    sound = weapon.isDagger ? SND.whiffDagger : pick(SND.whiffSword);
  }
  return { outcome, roll, total, ac, weapon, damage, sound, crit, fumble, threat, confirmRoll, confirmTotal };
}

/** Resolve a spell attack (Lightning Bolt or Stinking Cloud). Cosmetic.
 *
 *  DC          = 10 + caster's total magic bonus.
 *  Save        = d20 + target's Cloak of Resistance bonus (cloak tier),
 *                with natural 1 = auto-fail and natural 20 = auto-success.
 *  Lightning Bolt: Reflex save; damage = (total magic bonus)d6 lightning,
 *                  halved on a successful save (0 if the caster owns no gear).
 *  Stinking Cloud: Fortitude save; on a failure the target is SICKENED.
 *
 *  @param {'lightning'|'stinking'} type
 */
function resolveSpell(type, casterGear, targetGear) {
  // Spell power scales with the caster's total magic bonus, but never below a
  // floor — a spell should ALWAYS cast (the target saves or doesn't); it should
  // never "fizzle" just because the caster owns no magic items. Floor 2 = a
  // modest 2d6 bolt / DC 12 cloud for a gearless caster.
  const power = Math.max(2, totalMagicBonus(casterGear));
  const dc = 10 + power;
  const cloak = (targetGear && Number(targetGear.cloak)) || 0;
  const saveRoll = dRoll(20);
  const saveTotal = saveRoll + cloak;
  const saved = saveRoll === 20 ? true : saveRoll === 1 ? false : (saveTotal >= dc);

  if (type === 'lightning') {
    let full = 0;
    for (let i = 0; i < power; i++) full += dRoll(6);
    const damage = saved ? Math.floor(full / 2) : full;
    return { type, save: 'Reflex', dc, power, dice: power, cloak, saveRoll, saveTotal, saved, fullDamage: full, damage, sound: pick(SND.lightning) };
  }
  // stinking cloud
  return { type, save: 'Fortitude', dc, power, cloak, saveRoll, saveTotal, saved, sickened: !saved, sound: pick(SND.stink) };
}

module.exports = { resolveSwing, resolveSpell, weaponOf, acOf, totalMagicBonus, SND, dRoll, pick };
