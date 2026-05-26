/**
 * Random flavor-text generators for the chat log.
 *
 * Kept here so the rest of the game logic stays focused. Picky about tone:
 * tabletop-friendly, slightly absurd, suitable for friends. No real-world
 * politics, no slurs, no anything you wouldn't say to your D&D table.
 */

// Every verb must read naturally in the template "${nick} ${verb} their ${item}".
// Phrasal verbs that need the object in the middle (e.g. "shoved X across the
// counter") are deliberately avoided.
const VERBS = [
  'hocked', 'pawned', 'sold', 'traded away', 'bartered', 'surrendered',
  'auctioned off', 'gambled away', 'mortgaged',
  'fenced', 'liquidated', 'tearfully parted with',
  'hawked', 'unloaded', 'pawned off', 'leveraged',
];

// All entries should be tabletop-flavored or believably sketchy — the
// kind of thing a desperate adventurer (or NPC fence) would actually
// move. No real-world brands or anything you wouldn't say at the table.
const ITEMS = [
  // D&D classics
  'prized ceremonial dagger',
  'soul to a passing devil',
  'library of forbidden texts',
  'holy symbol of a now-very-confused deity',
  'favorite cloak (the one with the secret pockets)',
  'familiar\'s favorite chew toy',
  'backup spellbook',
  'lucky dice',
  'most reliable nightmare',
  'lucky pocket squirrel',
  'rare collection of monster teeth',
  'bag of holding (and everything inside it)',
  'first-edition bestiary',
  'lifetime membership to the Adventurers\' Guild',
  'pet owl\'s retirement fund',
  'collection of cursed wedding rings',
  'lifetime supply of healing potions',
  'birthright to a small, irritable kingdom',
  'tax-exempt status at six temples',
  'season tickets to the gladiator pits',
  'IOU signed in lich-blood',
  'hat of disguise (currently disguised as a hat)',
  'decanter of endless dwarven moonshine',
  'portable hole (folded into a smaller, less-portable hole)',
  'bag of devouring (empty… probably)',
  'horn of blasting (only blasts on Tuesdays)',
  'thieves\' guild membership card (lapsed)',
  'contract with a hag (paid up, mostly)',
  'jar of pickled imp tongues',
  'minor ring of luck (out of charges)',
  'cursed orb that whispers their failures',
  'last pinch of dust of disappearance',
  'love letter from a succubus',
  'expired diplomatic immunity scroll',
  'letter of marque from a pirate king',
  'counterfeit holy symbol (very convincing)',
  'collection of severed beholder eyes',
  'spare prosthetic eye (the magical one)',
  'treasure map (everyone who followed it died)',
  'membership in the Necromancers\' Local 612',
  'wand of "almost certainly not necromancy"',
  'mummified hand of glory (left)',
  'one (1) very loyal kobold servant',
  'half-share of a flying carpet (the wrong half)',
  'deed to a haunted windmill',
  'jeweled codpiece (slightly used)',
  'timeshare in the Feywild (overlaps with a hag\'s house)',
  'bag of beans (1 magic, 47 regular)',
  'hand-drawn maps to dungeons that don\'t exist anymore',
  'ancestral dragon-scale loincloth',
  'inheritance from a dead uncle (encumbered)',
  'promissory note signed in their own blood',
  'claim to a haunted ancestral keep',
  'seat in the Wizard Hat Hall of Fame',
  'compromising love letters from a halfling baker',
  'unfinished memoir',
  'jar of teeth (allegedly orc)',
  'subscription to "Modern Murderhobo Weekly"',
  'two-thirds of a vorpal sword (the wrong two-thirds)',
  'a goblin debt enforcer they\'ve been ducking',

  // Sketchy & embarrassing
  'entire collection of underwear',
  'mother\'s wedding ring',
  'emergency snack stash',
  'spare boots',
  'ancestral smoking pipe',
  'private journal (the embarrassing one)',
  'secret cookie recipe',
  'pet rat named Mr. Whiskers',
  'enchanted moustache wax',
  'collection of pressed flowers',
  'reputation in three separate cities',
  'standing weekly bath appointment',
  'mother-in-law\'s good silver',
  'illegitimate twin\'s identity papers',
  'one (1) functioning kidney',
  'good name (mostly)',
  'meticulously braided ear hair',
  'spare set of dentures',
  'father\'s eulogy notes',
  'standing tab at three taverns',
  'gambling debt to the previous innkeeper',
  'box of letters from their vampire stalker',
  'enchanted comb (works on hair they no longer have)',
  'contract to slay a dragon they never quite got around to',
  'wardrobe of "casual paladin wear"',
  'rights to their bardic ballad about a one-eyed cleric',
  'understanding of the Cube of Force\'s instruction manual',
  'jewel of "definitely not stolen from a temple"',
  'compromising tavern receipts',
];

const SUFFIXES = [
  'to rejoin the table!',
  'just to climb back in!',
  'for one more shot at the pot!',
  'to buy back in!',
  'to take another seat!',
  'to bankroll a comeback!',
  'so they can stop being broke!',
  'because pride is cheaper than poverty!',
  'so the dealer would let them sit again!',
  'in a deal they\'ll definitely regret tomorrow!',
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
