/**
 * Standard 52-card deck. Cryptographically random shuffle (Fisher-Yates with
 * crypto.randomInt) — predictable RNGs are a real cheating vector for cards.
 *
 * Card representation: 2-char strings used by pokersolver, e.g. "As", "Td", "2c".
 *   Ranks: 2 3 4 5 6 7 8 9 T J Q K A
 *   Suits: s (spades) h (hearts) d (diamonds) c (clubs)
 */

const crypto = require('crypto');

const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS = ['s','h','d','c'];

function buildDeck() {
  const out = [];
  for (const r of RANKS) for (const s of SUITS) out.push(r + s);
  return out;
}

class Deck {
  constructor() {
    this.cards = buildDeck();
    this.shuffle();
  }

  shuffle() {
    // Fisher–Yates with crypto-grade RNG.
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
    return this;
  }

  draw(n = 1) {
    if (n > this.cards.length) throw new Error('deck exhausted');
    return this.cards.splice(0, n);
  }

  burn() { this.cards.shift(); }

  remaining() { return this.cards.length; }
}

module.exports = { Deck, RANKS, SUITS };
