/**
 * 11labs voice_id mapping per character nickname.
 *
 * Keyed by the exact `nickname` field stored on the player record (which
 * matches CHARACTER_FLAVOR keys in banter.js). Add entries as you pick
 * voices in the 11labs Voice Library or Voice Design tool — copy the
 * voice_id (28-char base62 string) from the URL or the "Copy ID" button.
 *
 * Behaviour:
 *   - Characters NOT in this map fall through to text-only chat. The
 *     banter system still works, just no audio for them. So you can
 *     populate this incrementally — no need to do all 38 at once.
 *   - If you want a character explicitly silent (no voice, even if a
 *     default is added later), use the literal `null` value here.
 *
 * Voice IDs are NOT secret — they're just identifiers, the API key is
 * what authenticates the request. Safe to commit in this file.
 */
const CHARACTER_VOICES = {
  // Fill in as voices get picked. Examples of the structure:
  //   'Toni':        'AZnzlk1XvdvUeBnXmlld',
  //   'Tar Baphon':  'pNInz6obpgDQGcFmaJgB',
  //
  // (Remove this comment block once entries exist.)
};

/** Look up a voice_id by nickname. Returns null if no mapping. */
function voiceFor(nickname) {
  if (!nickname) return null;
  const v = CHARACTER_VOICES[nickname];
  // Explicit null in the map means "intentionally silent" — treat
  // the same as missing for synthesis purposes.
  return v || null;
}

module.exports = { CHARACTER_VOICES, voiceFor };
