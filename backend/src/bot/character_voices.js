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
  'Fera':              'SxrdCBV2iTasBWWDffJ4', // Paris Hilton
  'Holden':            '0exky5u6rYq7ksXZEN5G', // Nick
  'Kate':              '5tQ5OiKpM78sVuxrgC4W', // Phoebe
  'Vaughan':           'CJnd8k7Q0w2Y1HegJ65F', // John 117
  // FARRAH ─ user priority order: British > young > aristocratic.
  // Library has no young+British+female combination. Picking the
  // youngest-feeling British female available — Alice ("Clear,
  // Engaging Educator") leans teacherly which fits the sharp-
  // detective Farrah pictures, and reads younger than Lily/Tamsin.
  // Original pick was Mimi2 (NmuGDgA7keY3NYIjArX3, age=child) but it
  // returned 403 voice_access_denied / detected_captcha_voice from
  // 11labs — needs manual verification on the user's dashboard
  // before it can be used via API. Swap back here once verified.
  // (Voice is shared with Kelda — voice IDs aren't exclusive.)
  'Farrah':            'Xb7hH8MSUJpSbSDYk0k2', // Alice — British, prioritising British+youngish
  'Kai Ginn':          'Yj3XGMd9w2H4C0P0L28M', // Sean
  'Daramid':           'poTX7WPM13yOc28z0sVi', // Shoreh Thing
  'Sirona':            'EXAVITQu4vr4xnSDxMaL', // Sarah — Mature, Reassuring, Confident (paladin barking orders)
  'Gaspar':            'zmw8ZGHS2l5ZG2v3AQ31', // Ultron
  'Farrus Richton':    'P2tOmMO16sLs34Jodjvk', // Verner Hishog
  'Lirienne':          'hpp4J3VqNfWAUOO0d1Us', // Bella - Professional, Bright, Warm

  // ===== Defaults picked from your 11labs library — adjust as desired =====
  // Carrion Crown / Caliphas crowd
  'Storgrim':          'JBFqnCBsd6RMkjVDRZzb', // George — Warm, Captivating Storyteller (British, mid-aged)
  'Ulfred':            'pqHfZKP75CvOlQylNhV4', // Bill — Wise, Mature, Balanced (old, male) — orthodox dwarf cleric
  'Tamsin':            'dAlhI9qAHVIjXuVppzhW', // Tamsin — Engaging British storyteller (name-match!)
  'Toni':              'pFZP5JQG7iQjIQuC4Bku', // Lily — Velvety Actress (British, mid-aged) — vampire velvet
  'Agu':               'cjVigY5qzO86Huf0OWal', // Eric — Smooth, Trustworthy — polite Norgorber inquisitor
  'Tar Baphon':        'Hjzqw9NR0xFMYU9Us0DL', // Reginald — labelled "evil" — fits an ancient lich-king

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
  'Lou Candlebean':    'gHu9GtaHOXcSqFTK06ux', // Anjali — Warm, Cheerful and Clear — cheerful gnome
  'Elodie':            'cVd39cx0VtXNC13y5Y7z', // Hope — Vibrant, Warm and Innocent — kind bard
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
