/**
 * Stored sound-effect pools per character.
 *
 * For characters whose "voice" isn't speech at all — Crisp's chirps,
 * Elfrip's belches — we'd rather play a pre-recorded sample than
 * burn 11labs credits trying to synthesise something the model
 * can't actually do well.
 *
 * Behaviour:
 *   - Keys are exact nicknames (same convention as CHARACTER_VOICES).
 *   - Values are arrays of URL paths under /audio/ (served by nginx
 *     from public/audio/).
 *   - banter.js prefers a sound pool over 11labs synthesis: if the
 *     character has a pool, we pick a random clip, attach its URL
 *     to the chat broadcast, and skip the API call entirely.
 *   - Empty pool or no entry → fall through to normal voice-id lookup.
 *
 * Add a character here by dropping clips into public/audio/ and
 * listing them below. No restart of the frontend needed (nginx
 * bind-mounts public/), just a backend recreate.
 */
const CHARACTER_SOUNDS = {
  // Crisp the juvenile velociraptor — chirps, hisses, snarls.
  // Foundry hypetracks + 11labs-created dino effects.
  'Crisp': [
    '/audio/crisp_01.mp3',  // velociraptor_hiss_bonk_bite
    '/audio/crisp_02.mp3',  // velociraptor_ripple_bark
    '/audio/crisp_03.mp3',  // velociraptor_snuffle_snarl
    '/audio/crisp_04.mp3',  // a_dinosaur_activatin
  ],
  // Elfrip the goblin cleric — handled specially in banter.js
  // (75% burp-only path, 25% LLM-spoken-line path with his 11labs
  // voice). The burp clips live in this module under the special
  // BURP_POOL export below so banter.js can grab one for the burp
  // path without invoking the normal soundFor route — keeps his
  // talk path clean for the 11labs synthesis call.
};

/** Elfrip-specific burp pool. Not part of CHARACTER_SOUNDS because
 *  the burp / talk decision is made by banter.js, not by the generic
 *  soundFor() lookup. */
const ELFRIP_BURPS = [
  '/audio/elfrip_01.mp3', // beer_drink_grunt_belch_burp
  '/audio/elfrip_02.mp3', // belch_huge
  '/audio/elfrip_03.mp3', // Burp sound effect
];
function randomElfripBurp() {
  return ELFRIP_BURPS[Math.floor(Math.random() * ELFRIP_BURPS.length)];
}

/** Pick a random sound URL for a character, or null if no pool. */
function soundFor(nickname) {
  if (!nickname) return null;
  const pool = CHARACTER_SOUNDS[nickname];
  if (!Array.isArray(pool) || pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { CHARACTER_SOUNDS, soundFor, ELFRIP_BURPS, randomElfripBurp };
