/**
 * Single source of truth for character-name pronunciation overrides.
 *
 * Consumed by BOTH text-to-speech paths:
 *   - server-side  util/elevenlabs.js   (ElevenLabs character voices)
 *   - client-side  public/js/blindMode.js (browser Web Speech narration),
 *     which fetches this list at runtime via GET /api/pronunciations.
 *
 * Each entry is [writtenName, phoneticSpelling], applied as a case-insensitive
 * word-boundary replace. Add ONE pair here and both TTS engines pick it up —
 * there is no second place to edit.
 */
const PRONUNCIATIONS = [
  ['Mandore',    'Man door'],
  ['Conchobar',  'Con cho barr'],
  ['Lirienne',   'leery-ehn'],    // one three-syllable word (hyphen → no mid-name pause)
  ['Rissa',      'Riss-uh'],      // short for Clarissa Caromarc — RIH-suh, short 'i'
  ['Bujon',      'Boo han'],
  ['Olbryn',     'Old brin'],   // Josh's drow sorcerer (his speech-to-text garbles it as "old brain")
  ['Casandalee', 'Cassan dah-lee'],
  ['Tobis',      'Toe biss'],
  ['Adimarus',   'Add ih mare us'],
  ['Mylez',      'Miles'],
  ['Taelys',     'Tay liss'],
  ['Rhyarca',    'ree-arka'],     // one three-syllable word (hyphen → no mid-name pause)
  ['Agu',        'ag-yew'],       // AG-yew
  ['Kovira',     'Koh vee rah'],
  ['Kai Ginn',   'Kai Jinn'],
  ['Kai Gin',    'Kai Jinn'],      // bio sometimes spells it "Kai Gin"
  ['Gaspar',     'Gas par'],
  ['Fera',       'feer-ah'],     // FEER-ah (hyphen → one smooth word, no mid-name pause)
  ['Sirona',     'sih-roh-nah'], // SIH-roh-nah
  ['Richton',    'Rick ton'],     // Farrah & her great-grandfather Farrus Richton
  ['Daramid',    'darramidd'],    // Judge Daramid — DAR-ah-mid
  ['bilge',      'bilj'],          // rhymes-ish with "build"; NOT "bill-jah" (common in pirate "bilge rat")
  ['sus',        'suhss'],         // short for "suspicious" — /sʌs/, like the start of the word, NOT "S-U-S"
  ['fr',         'for real'],      // zoomer slang — "fr" = "for real" (so "fr fr" → "for real for real")
];

module.exports = { PRONUNCIATIONS };
