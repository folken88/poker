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
  ['Lirienne',   'Leery in'],
  ['Bujon',      'Boo han'],
  ['Casandalee', 'Cassan dah-lee'],
  ['Tobis',      'Toe biss'],
  ['Adimarus',   'Add ih mare us'],
  ['Mylez',      'Miles'],
  ['Taelys',     'Tay liss'],
  ['Rhyarca',    'Ree ark ah'],
  ['Kovira',     'Koh vee rah'],
  ['Kai Ginn',   'Kai Jinn'],
  ['Kai Gin',    'Kai Jinn'],      // bio sometimes spells it "Kai Gin"
  ['Gaspar',     'Gas par'],
  ['Fera',       'Fear ah'],
  ['bilge',      'bilj'],          // rhymes-ish with "build"; NOT "bill-jah" (common in pirate "bilge rat")
];

module.exports = { PRONUNCIATIONS };
