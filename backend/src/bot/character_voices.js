/**
 * 11labs voice_id mapping per character nickname.
 *
 * Keys are the exact `nickname` field on the player record (same keys
 * used in banter.js CHARACTER_FLAVOR). Values are 28-char base62
 * voice_ids copied from the 11labs Voice Library / Voice Design tool.
 *
 * Voice IDs are not secret — they're public identifiers; the API key
 * (in .env, never committed) is what authenticates the request. Safe
 * to commit this file.
 *
 * Behaviour:
 *   - Missing entries route to text-only chat (LLM line ships without
 *     audio). So this map can grow incrementally.
 *   - `null` value means "intentionally silent" — distinguishes a
 *     deliberate choice from an oversight.
 *   - Vorkstag is special: he wears tablemates' faces (Seat.avatarOverride
 *     in Table.js) and ALSO their voices. voiceFor() handles that
 *     by looking up the impersonated character via seat.impersonatedNick.
 */
const CHARACTER_VOICES = {
  // ===== User-specified picks (resolved against your 11labs library) =====
  'Meyanda':           'cv1wzQCiuTUODTiqaejJ', // Shephard
  'Dismas':            'au1YaxffncrR0oxXadhQ', // Sam (texas, old, male) — Holy Gun Paladin
  'Rissa':             'URIgxRJTnLWzzErmZJcO', // Anika
  'Conchobar':         'xytDFh9V3d1GsWzN9QtU', // Arnold2
  'Kovira':            'XEfmp5jx6r6TvMKPXzmU', // Chloe
  'Auren Vrood':       'W7MNPyraMJMDLKLmVax4', // Dracula
  'Elfrip':            'RmAKjzepcBoIcYivho4T', // Elfrip (purpose-built)
  'Estovion':          'GEDXnQvfyd3quuXsFgKU', // Felix
  'Concetta':          'N12IBDu5SgDfzO6CjVXD', // Hannah - raspy
  'Tokala':            'CPrddi89utXexSfHFD7y', // Prime
  'Duristan':          'PdgFJYFiU4tFS8jEZkDF', // Berry
  'Mr. Brow':          'UoOL4r5ZefvNkwdKzfLN', // Hank
  'Adimarus':          '5mU8WBEmVJQ3n5J4fkzR', // Okole
  'Bujon':             '5mU8WBEmVJQ3n5J4fkzR', // Okole — shared with Adimarus; voice IDs aren't exclusive
  'Fera':              'SxrdCBV2iTasBWWDffJ4', // Paris Hilton
  'Texas Holden':      '0exky5u6rYq7ksXZEN5G', // Nick (display name is "Texas Holden" — the poker pun he never caught)
  'Kate':              '5tQ5OiKpM78sVuxrgC4W', // Phoebe
  'Vaughan':           'CJnd8k7Q0w2Y1HegJ65F', // John 117
  // FARRAH ─ Mimi (Vnqlgu3fdiFwisAye1qH, Swedish, young, "cute").
  // Probed clean (HTTP 200, ~14kB) so it works straight through the
  // current model. NOT British — but the original Mimi2 (English
  // child) returned 403 voice_access_denied / detected_captcha_voice
  // and needs manual verification on the 11labs dashboard before
  // API use. User picked Mimi explicitly knowing the trade-off.
  'Farrah':            'Vnqlgu3fdiFwisAye1qH', // Mimi — young female, Swedish accent
  'Kai Ginn':          'Yj3XGMd9w2H4C0P0L28M', // Sean
  'Daramid':           'poTX7WPM13yOc28z0sVi', // Shoreh Thing
  'Sirona':            'EXAVITQu4vr4xnSDxMaL', // Sarah — Mature, Reassuring, Confident (paladin barking orders)
  'Gaspar':            'zmw8ZGHS2l5ZG2v3AQ31', // Ultron
  'Farrus Richton':    'P2tOmMO16sLs34Jodjvk', // Verner Hishog
  'Lirienne':          'hpp4J3VqNfWAUOO0d1Us', // Bella - Professional, Bright, Warm

  // ===== Defaults picked from your 11labs library — adjust as desired =====
  // Carrion Crown / Caliphas crowd
  'Storgrim':          'oCXdm5WkYoKVEdlbPLev', // Paul — Deep & Warm Yorkshire (shared library) — northern English dwarf captain
  'Ulfred':            'bFrjFL4nlpeYNwNRhXxq', // Mossbeard — Scottish, old, raspy ("God of the Wild") — deep dwarf-cleric energy (shared library)
  'Tamsin':            'dAlhI9qAHVIjXuVppzhW', // Tamsin — Engaging British storyteller (name-match!)
  'Toni':              'pFZP5JQG7iQjIQuC4Bku', // Lily — Velvety Actress (British, mid-aged) — vampire velvet
  'Agu':               'cjVigY5qzO86Huf0OWal', // Eric — Smooth, Trustworthy — polite Norgorber inquisitor
  'Tar Baphon':        'UzI1NsMEV3ni5JRkRSls', // Alistair — Cultured and Articulate (shared library) — old aristocratic British, lich-king energy

  // Numerian / Iron Gods
  'Dinvaya':           'qSeXEcewz7tA0Q0qk9fH', // Victoria — Warm, Trustworthy, Relatable
  'Casandalee':        'XrExE9yKIg1WjnnlVkGX', // Matilda — Knowledgable, Professional — calm AI
  'Nomkath':           'l4Coq6695JDX9xtLqXDE', // Lauren B — Warm, Humanlike, Conversational

  // Skull & Shackles / pirates
  'Rhyarca':           'cgSgspJ2msm6clMCkdW9', // Jessica — Playful, Bright, Warm — theatrical Besmara oracle

  // Hell's Rebels / desert / odds
  'Taelys':            'RILOU7YmBhvwJGDGjNmP', // Jane — Professional Audiobook Reader (British, old) — gravitas
  'Kelda':             'Xb7hH8MSUJpSbSDYk0k2', // Alice — Clear, Engaging Educator (British) — dry cynic
  'Vesorianna':        'Ir1QNHvhaJXbAGhT50w3', // Sara Martin — Light, Intimate and Tender — ethereal ghost
  'Lou Candlebean':    'FGY2WhTYpPnrIDTdsKH5', // Laura — Enthusiast, Quirky Attitude (young, American, sassy) — hip gnome
  'Elodie':            'CKfuQaJKfvUG2Wtrda3Y', // Lison — French (shared library), young + soft
  'Chef':              'SOYHLrjzK2X1ezoPC6cr', // Harry — Fierce Warrior — shouty Ramsay

  // Crisp: chirps and pops only, no English. 11labs sound-effects
  // API is a separate path — leaving null until we wire it up.
  'Crisp':             null,

  // Vorkstag: see voiceFor() — he uses the voice of whoever he's
  // impersonating, not a fixed voice of his own. Direct lookup
  // returns null on purpose.
  'Vorkstag':          null,
};

/** Look up the voice_id for a speaker.
 *  @param {string} nickname  The speaker's display nickname.
 *  @param {object} [seat]    Optional seat reference. Required for
 *                            Vorkstag's impersonation mechanic — when
 *                            seat.impersonatedNick is present, his
 *                            voice mirrors the impersonated character.
 *  @returns {string|null}    voice_id, or null = silent (text-only).
 */
function voiceFor(nickname, seat) {
  if (!nickname) return null;
  // Vorkstag wears tablemates' faces (Seat.avatarOverride) AND their
  // voices. Table.seatBot sets seat.impersonatedNick alongside the
  // avatar override; here we route lookups to that nickname instead.
  // If the impersonated character has no voice (e.g. a human player
  // we stole from), or no map entry, we return null — Vorkstag goes
  // silent until he picks a face that comes with a voice.
  if (nickname === 'Vorkstag' && seat?.impersonatedNick) {
    const v = CHARACTER_VOICES[seat.impersonatedNick];
    return v || null;
  }
  return CHARACTER_VOICES[nickname] || null;
}

module.exports = { CHARACTER_VOICES, voiceFor };
