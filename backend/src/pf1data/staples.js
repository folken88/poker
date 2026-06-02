/**
 * The "staple" weapons offered in the weapon-choice dropdown. Each resolves to
 * the full PF1 stats from weapons.js; Unarmed Strike is added from the PF1 SRD
 * (it isn't in the Foundry weapons pack). `key` is the stable storage value.
 *
 * Players start on the Dagger at MASTERWORK quality (see combat: masterwork =
 * +1 to hit / +0 damage; a purchased +N enhancement rides on the chosen weapon).
 */
const { WEAPON_BY_NAME } = require('./weapons');

const UNARMED = { name: 'Unarmed Strike', cat: 'light', ranged: false, dmgCount: 1, dmgDie: 3, crit: 20, mult: 2, type: 'B', group: 'natural' };

const STAPLE_DEFS = [
  ['dagger',       'Dagger'],
  ['shortsword',   'Shortsword'],
  ['longsword',    'Longsword'],
  ['greatsword',   'Greatsword'],
  ['warhammer',    'Warhammer'],
  ['battleaxe',    'Battle Axe'],
  ['greataxe',     'Greataxe'],
  ['longspear',    'Longspear'],
  ['quarterstaff', 'Quarterstaff'],
  ['unarmed',      null],          // SRD entry (UNARMED above)
  ['katana',       'Katana'],
  ['scimitar',     'Scimitar'],
  ['rapier',       'Rapier'],
  ['glaive',       'Glaive'],      // representative polearm
  ['whip',         'Whip'],
];

const STAPLE_WEAPONS = STAPLE_DEFS.map(([key, name]) => {
  const w = key === 'unarmed' ? UNARMED : WEAPON_BY_NAME[String(name).toLowerCase()];
  if (!w) throw new Error(`staple weapon not found: ${name}`);
  return { key, ...w };
});
const STAPLE_BY_KEY = Object.fromEntries(STAPLE_WEAPONS.map(w => [w.key, w]));
const DEFAULT_WEAPON = 'dagger';

module.exports = { STAPLE_WEAPONS, STAPLE_BY_KEY, DEFAULT_WEAPON };
