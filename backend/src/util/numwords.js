/**
 * Integer → English words, for amounts we hand to the LLM banter model.
 *
 * Why this exists: the small banter model misreads bare digit strings —
 * it rendered "152 gp" aloud as "fifteen two" (reading the digits in
 * pairs). Feeding it spelled-out words instead ("one hundred fifty-two")
 * removes the digit-grouping failure mode entirely: there is no digit
 * string left to mis-chunk. Used in the event descriptions (Table.js)
 * and the wealth context (banter.buildTableContext) so every gp figure
 * the model sees is unambiguous.
 *
 * NOTE: this is ONLY for text fed to the LLM. The player-facing chat log
 * (action lines, win lines) keeps normal digits via toLocaleString().
 */

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function under1000(n) {
  let s = '';
  if (n >= 100) {
    s += ONES[Math.floor(n / 100)] + ' hundred';
    n %= 100;
    if (n) s += ' ';
  }
  if (n >= 20) {
    s += TENS[Math.floor(n / 10)];
    n %= 10;
    if (n) s += '-' + ONES[n];
  } else if (n > 0) {
    s += ONES[n];
  }
  return s;
}

/** Spell out a non-negative integer (rounded). Handles 0 .. 999,999,999,
 *  which comfortably covers any in-game amount (Loot Lord total ≈ 177k). */
function numWords(value) {
  let n = Math.round(Number(value) || 0);
  if (n < 0) return 'negative ' + numWords(-n);
  if (n === 0) return 'zero';
  const parts = [];
  const million = Math.floor(n / 1000000); n %= 1000000;
  const thousand = Math.floor(n / 1000);   n %= 1000;
  if (million)  parts.push(under1000(million) + ' million');
  if (thousand) parts.push(under1000(thousand) + ' thousand');
  if (n)        parts.push(under1000(n));
  return parts.join(' ');
}

/** numWords + " gold" — the form used for spoken gp amounts. */
function gold(value) {
  return numWords(value) + ' gold';
}

module.exports = { numWords, gold };
