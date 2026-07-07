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
/** Fallback voice for Vorkstag when he steals a face whose owner has
 *  no voice mapped (most humans, occasionally an unmapped bot). Reuses
 *  the Dracula voice — same one Auren Vrood uses — because (a) the
 *  skinwalker's true-form menace lines up with it tonally, and (b)
 *  going silent would tip the table off that something's wrong with
 *  whoever's seat he's in. Kept as a named constant so the intent is
 *  obvious at the voiceFor() callsite. */
const VORKSTAG_FALLBACK_VOICE = 'W7MNPyraMJMDLKLmVax4'; // Dracula

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
  'Bujon':             'KLs0efvyfWnIfXc9u1Jk', // Sanjay - profound and deep
  'Olbryn':            'KLs0efvyfWnIfXc9u1Jk', // Sanjay - same voice as Bujon (Tobias 2026-06-23)
  'Fera':              'SxrdCBV2iTasBWWDffJ4', // Paris Hilton
  'Texas Holden':      '0exky5u6rYq7ksXZEN5G', // Nick (display name is "Texas Holden" — the poker pun he never caught)
  'Danger':            '0exky5u6rYq7ksXZEN5G', // Nick — Rodney "Danger" Smith, redneck CP-USS ranger
  'Kate':              '5tQ5OiKpM78sVuxrgC4W', // Phoebe
  'Vaughan':           'CJnd8k7Q0w2Y1HegJ65F', // John 117
  'Radiance':          'mmndVSeLErK7c5SRoKg5', // Tresdin voice — Vaughan's SENTIENT scimitar (the Inquisitor-of-Pharasma soul in the blade); a second "voice" of Vaughan, heard by the table on his miss/drop/undead-kill
  // FARRAH ─ Mimi (Vnqlgu3fdiFwisAye1qH, Swedish, young, "cute").
  // Probed clean (HTTP 200, ~14kB) so it works straight through the
  // current model. NOT British — but the original Mimi2 (English
  // child) returned 403 voice_access_denied / detected_captcha_voice
  // and needs manual verification on the 11labs dashboard before
  // API use. User picked Mimi explicitly knowing the trade-off.
  'Farrah':            'Vnqlgu3fdiFwisAye1qH', // Mimi — young female, Swedish accent
  'Kai Ginn':          'Yj3XGMd9w2H4C0P0L28M', // Sean
  'Daramid':           'poTX7WPM13yOc28z0sVi', // Shoreh Thing
  'Ser Toche':         'poTX7WPM13yOc28z0sVi', // Shoreh Thing (shared with Daramid) — tengu rogue, rarely speaks
  'El Guapo':          'GEDXnQvfyd3quuXsFgKU', // Felix (shared with Estovion) — flamboyant swashbuckler gambler
  'Gabriel':           'UoOL4r5ZefvNkwdKzfLN', // Hank (shared with Mr. Brow) — warm, steady paladin
  'Sirona':            'mmndVSeLErK7c5SRoKg5', // Tresdin (user pick) — strong, aggressive female army-commander (paladin barking orders)
  'Gaspar':            'zmw8ZGHS2l5ZG2v3AQ31', // Ultron
  'Farrus Richton':    'P2tOmMO16sLs34Jodjvk', // Verner Hishog — Werner-Herzog-style older German-accented male; user confirmed German accent works
  'Lirienne':          'hpp4J3VqNfWAUOO0d1Us', // Bella - Professional, Bright, Warm

  // ===== Defaults picked from your 11labs library — adjust as desired =====
  // Carrion Crown / Caliphas crowd
  'Storgrim':          'xytDFh9V3d1GsWzN9QtU', // Arnold2 (user pick; also Conchobar's voice) — replaced Paul (Yorkshire)
  'Ulfred':            'xytDFh9V3d1GsWzN9QtU', // Arnold2 (user pick) — replaced Sean
  'Tamsin':            'dAlhI9qAHVIjXuVppzhW', // Tamsin — Engaging British storyteller (name-match!)
  'Toni':              'pFZP5JQG7iQjIQuC4Bku', // Lily — Velvety Actress (British, mid-aged) — vampire velvet
  'Agu':               'XB0fDUnXU5powFXDhCwa', // Charlotte (11labs default, Swedish-accented mature female — placeholder for "Slavic middle-aged woman"; swap to a specific library voice when one is picked)
  'Tar Baphon':        'UzI1NsMEV3ni5JRkRSls', // Alistair — Cultured and Articulate (shared library) — old aristocratic British, lich-king energy

  // Numerian / Iron Gods
  'Dinvaya':           'qSeXEcewz7tA0Q0qk9fH', // Victoria — Warm, Trustworthy, Relatable
  'Binch':             'mmndVSeLErK7c5SRoKg5', // Tresdin (user pick) — surly, grumpy, firm Besmara priestess
  'Celeb':             'onwK4e9ZLuTAKqWW03F9', // Daniel — steady, authoritative BRITISH broadcaster, middle-aged male (Nethys scholar-cleric; user pick, was Adam)
  'Casandalee':        'XrExE9yKIg1WjnnlVkGX', // Matilda — Knowledgable, Professional — calm AI
  'Nomkath':           'ErXwobaYiN019PkySvjV', // Antoni — young American male, well-rounded (catfolk_male rogue)

  // Skull & Shackles / pirates
  'Rhyarca':           'cgSgspJ2msm6clMCkdW9', // Jessica — Playful, Bright, Warm — theatrical Besmara oracle

  // Hell's Rebels / desert / odds
  'Taelys':            'AZnzlk1XvdvUeBnXmlld', // Domi — young American woman, confident/snarky (stand-in; swap to a named voice on request)
  'Kelda':             'Xb7hH8MSUJpSbSDYk0k2', // Alice — Clear, Engaging Educator (British) — dry cynic
  'Vesorianna':        'Ir1QNHvhaJXbAGhT50w3', // Sara Martin — Light, Intimate and Tender — ethereal ghost
  'Lou Candlebean':    'FGY2WhTYpPnrIDTdsKH5', // Laura — Enthusiast, Quirky Attitude (young, American, sassy) — hip gnome
  'Elodie':            'CKfuQaJKfvUG2Wtrda3Y', // Lison — French (shared library), young + soft
  'Chef':              'SOYHLrjzK2X1ezoPC6cr', // Harry — Fierce Warrior — shouty Ramsay

  // Crisp: chirps and pops only, no English. 11labs sound-effects
  // API is a separate path — leaving null until we wire it up.
  'Crisp':             null,

  // Hell's Vengeance / Rebels PCs → AI-heroes (2026-07-05). PLACEHOLDER picks from
  // the existing library so they speak immediately — swap to purpose-picked 11labs
  // voices on request (like Farrah/Bujon/etc. were refined).
  'Femmik':            'E95b3lkMWHDsKeHJaIcY', // Henry - Charming Pro (user pick) — smooth, cocky Ifrit fire-dancer (shared 11labs voice, works directly; was Sean)
  'Azwraith':          'Yj3XGMd9w2H4C0P0L28M', // Sean (user pick) — the grim reach-fighter trip-lord (the voice Femmik vacated)
  'Lord Gweyir':       'gqOAQpRt9Y3Tlj9zcSFS', // Conor — young, eloquent, well-spoken BRITISH male = smarmy elf duelist (shared 11labs voice, works directly)
  'Freya':             'mmndVSeLErK7c5SRoKg5', // Tresdin (user pick) — strong, aggressive female army-commander: the half-elf field marshal
  "J'Mal":             'zmw8ZGHS2l5ZG2v3AQ31', // Ultron (user pick) — the cold Red Mantis assassin
  'Jason':             '5mU8WBEmVJQ3n5J4fkzR', // Okole (user pick) — the Asmodean priest
  'Reese':             'GEDXnQvfyd3quuXsFgKU', // Felix (user pick) — the winged Strix archer
  'Savage':            'KLs0efvyfWnIfXc9u1Jk', // Sanjay (user pick, shared w/ Bujon/Olbryn) — the tiefling bloodrager brute
  'Draymus':           'W7MNPyraMJMDLKLmVax4', // Dracula (user pick) — the dhampir necromancer's cold, aristocratic menace

  // Vorkstag: see voiceFor() — he uses the voice of whoever he's
  // impersonating (Seat.impersonatedNick). When the impersonated
  // target has no voice in this map (humans / unmapped bots), he
  // falls back to VORKSTAG_FALLBACK_VOICE below (Dracula) instead
  // of going silent — silence would be a tell. Direct lookup with
  // no seat returns null on purpose.
  'Vorkstag':          null,
};

/** Per-character voice_settings overrides. Each entry is a PARTIAL —
 *  only the keys listed here override the global defaults in
 *  elevenlabs.js (stability 0.45 / similarity_boost 0.75 / style 0.40 /
 *  use_speaker_boost true / speed 1.0). Everything unspecified inherits
 *  the default.
 *
 *  Why: with the global defaults a few voices read too "hot" — they
 *  rush and pitch up. 11labs has no real pitch knob, so the fix is to
 *  raise `stability`, drop `style` (less exaggeration), and set `speed`
 *  below 1.0 (valid range 0.7–1.2). Add an entry here when a character's
 *  delivery needs taming or a distinct tempo.
 *
 *  Routed through settingsFor() below, which (like voiceFor) follows
 *  Vorkstag's impersonation so a stolen voice also gets its owner's
 *  settings. */
const VOICE_SETTINGS = {
  // Gaspar (Pharasmin zealot, voice "Ultron") still reads a touch hot —
  // nudge him steadier and a hair slower than the (already calm) default.
  'Gaspar':   { stability: 0.60, speed: 0.88 },
  // (Ulfred's old speed:1.05 override is gone — it was tuned for the previous
  //  slow voice; Sean uses the global defaults. Re-add a tweak if he needs it.)
  // Duristan — languid, posh, low-energy register (Lazlo from "What We Do
  // in the Shadows"): extra-steady and notably unhurried.
  'Duristan': { stability: 0.65, similarity_boost: 0.80, speed: 0.82 },
  // The TRESDIN voice (Freya / Sirona / Binch) — a strong, aggressive female
  // commander. Tobias: keep her surly/grumpy and FIRM, easily annoyed. So we run
  // her STEADY (high stability = controlled, not sing-song), LESS theatrical (low
  // style), and a touch SLOW/heavy (speed < 1) — a clipped, no-nonsense delivery.
  'Freya':    { stability: 0.62, similarity_boost: 0.80, style: 0.25, speed: 0.95 },
  'Sirona':   { stability: 0.62, similarity_boost: 0.80, style: 0.25, speed: 0.95 },
  'Binch':    { stability: 0.62, similarity_boost: 0.80, style: 0.25, speed: 0.95 },
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
  // If the impersonated character has no voice in the map (e.g. a
  // human player we stole from, or a bot whose voice we never set),
  // we fall back to the Dracula voice — same one Auren Vrood uses,
  // it suits the skinwalker's true-form menace and means he's never
  // silent. Going silent would be a tell.
  if (nickname === 'Vorkstag' && seat?.impersonatedNick) {
    const v = CHARACTER_VOICES[seat.impersonatedNick];
    return v || VORKSTAG_FALLBACK_VOICE;
  }
  return CHARACTER_VOICES[nickname] || null;
}

/** Look up the per-character voice_settings override for a speaker, or
 *  null to use the global defaults. Mirrors voiceFor's Vorkstag routing
 *  so an impersonated voice also adopts the impersonated character's
 *  settings.
 *  @param {string} nickname  The speaker's display nickname.
 *  @param {object} [seat]    Optional seat (for Vorkstag impersonation).
 *  @returns {object|null}    Partial voice_settings, or null. */
function settingsFor(nickname, seat) {
  if (!nickname) return null;
  if (nickname === 'Vorkstag' && seat?.impersonatedNick) {
    return VOICE_SETTINGS[seat.impersonatedNick] || null;
  }
  return VOICE_SETTINGS[nickname] || null;
}

module.exports = { CHARACTER_VOICES, voiceFor, settingsFor };
