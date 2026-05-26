/**
 * Random flavor-text generators for the chat log.
 *
 * Kept here so the rest of the game logic stays focused. Picky about tone:
 * tabletop-friendly, slightly absurd, suitable for friends. No real-world
 * politics, no slurs, no anything you wouldn't say to your D&D table.
 */

const VERBS = [
  'hocked', 'pawned', 'sold', 'traded away', 'bartered', 'surrendered',
  'auctioned off', 'gambled away', 'mortgaged', 'shoved across the counter',
];

const ITEMS = [
  'entire collection of underwear',
  'prized ceremonial dagger',
  'mother\'s wedding ring',
  'soul to a passing devil',
  'library of forbidden texts',
  'emergency snack stash',
  'holy symbol of a now-very-confused deity',
  'favorite cloak (the one with the secret pockets)',
  'spare boots',
  'familiar\'s favorite chew toy',
  'backup spellbook',
  'lucky dice',
  'ancestral smoking pipe',
  'private journal (the embarrassing one)',
  'secret cookie recipe',
  'pet rat named Mr. Whiskers',
  'enchanted moustache wax',
  'collection of pressed flowers',
  'lifetime supply of healing potions',
  'reputation in three separate cities',
  'standing weekly bath appointment',
  'most reliable nightmare',
  'mother-in-law\'s good silver',
  'illegitimate twin\'s identity papers',
  'one (1) functioning kidney',
  'lucky pocket squirrel',
  'birthright to a small, irritable kingdom',
  'tax-exempt status at six temples',
  'season tickets to the gladiator pits',
  'unfinished memoir',
  'rare collection of monster teeth',
  'bag of holding (and everything inside it)',
  'good name (mostly)',
  'meticulously braided ear hair',
  'first-edition bestiary',
  'pet owl\'s retirement fund',
  'collection of cursed wedding rings',
  'spare set of dentures',
  'lifetime membership to the Adventurers\' Guild',
  'father\'s eulogy notes',
];

const SUFFIXES = [
  'to rejoin the table!',
  'just to climb back in!',
  'for one more shot at the pot!',
  'to buy back in!',
  'to take another seat!',
  'to bankroll a comeback!',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/** Generate "Storgrim hocked their X for 5000 gp to Y" line. */
function botRebuyMessage(nickname, amount) {
  return `${nickname} ${pick(VERBS)} their ${pick(ITEMS)} for ${amount.toLocaleString()} gp ${pick(SUFFIXES)}`;
}

const HUMAN_REBUY = [
  'is back at the table with a fresh stack of',
  'tapped the bank for',
  'put another',
  'is paying tomorrow-them with',
  'walked out, walked back in with',
];

/** Human re-buy line (no flavor items — humans are paying real debt). */
function humanRebuyMessage(nickname, amount) {
  return `${nickname} ${pick(HUMAN_REBUY)} ${amount.toLocaleString()} gp. (debt accrued.)`;
}

const BUST_LINES = [
  'is out of gp. Time for the walk of shame.',
  'busted out. The table observes a moment of silence.',
  'is broke. Anyone got a spare 5,000 gp?',
  'donked their last gp. Brutal.',
  'has departed the table with nothing but lessons.',
];
function bustMessage(nickname) {
  return `${nickname} ${pick(BUST_LINES)}`;
}

module.exports = { botRebuyMessage, humanRebuyMessage, bustMessage };
