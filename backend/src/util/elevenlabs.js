/**
 * 11labs (ElevenLabs) TTS client — server-side ONLY.
 *
 * The API key lives in process.env.ELEVENLABS_API_KEY (set by docker-
 * compose via .env). It MUST NEVER appear in any client-bound payload,
 * URL, log line, or error message. The HTTP call happens here, audio
 * bytes go out over the socket attached to the chat broadcast — that's
 * the only thing clients see.
 *
 * Public API:
 *   synthesize(text, voiceId)   -> { ok: true, audio: <base64 mp3> }
 *                                  | { ok: false, error: '...' }
 *
 * Failure modes are all silent to the caller — if anything goes wrong
 * (no key, rate limit, network, malformed voice id), we return
 * `{ ok: false }` and the caller falls back to text-only chat.
 */

const API_KEY      = process.env.ELEVENLABS_API_KEY || '';
// Default to the quality model (richer, more consistent prosody than the
// flash model, which rushed/pitched-up on short banter lines). Overridable
// via ELEVENLABS_MODEL. Slower (~1s/line) so the default timeout is roomier.
const MODEL        = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
const TIMEOUT_MS   = parseInt(process.env.ELEVENLABS_TIMEOUT_MS || '12000', 10);
const ENABLED      = !!API_KEY;

/** Global default voice_settings, applied to every character unless a
 *  per-character override is passed to synthesize() (see
 *  character_voices.settingsFor). Low stability + moderate style is
 *  expressive but can make some voices rush and pitch up; raise
 *  stability / drop style / set speed < 1.0 to settle a voice down.
 *  11labs has no direct pitch control — these knobs shape perceived
 *  pitch and pace. `speed` (0.7–1.2, default 1.0) is supported by the
 *  flash/multilingual models. */
const DEFAULT_VOICE_SETTINGS = {
  stability: 0.50,
  similarity_boost: 0.75,
  style: 0.0,         // 0 = ElevenLabs-natural (what Foundry's Talking Actors uses);
                      // higher values exaggerate delivery and push pitch/pace up.
  use_speaker_boost: true,
  speed: 0.90,        // < 1.0 to undo the rushed feel vs. Foundry (range 0.7–1.2).
};

// Defensive log on boot so ops can confirm the key was picked up,
// WITHOUT logging the key value itself. Format intentionally vague.
if (ENABLED) {
  console.log(`[11labs] enabled (model=${MODEL}, timeout=${TIMEOUT_MS}ms)`);
} else {
  console.log('[11labs] disabled (no ELEVENLABS_API_KEY in env)');
}

/** Written → phonetic-spelling pairs for names the 11labs voices
 *  routinely mispronounce. Applied as case-insensitive word-boundary
 *  replaces before the text is sent to the API, so character voicelines
 *  say "Leery in" instead of "Lirry-en" when one bot addresses another.
 *  Mirror entries in public/js/blindMode.js NAME_PRONUNCIATIONS so the
 *  browser TTS fallback also benefits.
 *  Add new pairs as users report butchered pronunciations. */
const PRONUNCIATIONS = [
  ['Mandore',    'Man door'],
  ['Lirienne',   'Leery in'],
  ['Bujon',      'Boo han'],
  ['Casandalee', 'Cassan dah-lee'],
  ['Tobis',      'Toe biss'],
  ['Adimarus',   'Add ih mare us'],
];
function applyPronunciations(text) {
  let out = text;
  for (const [orig, phon] of PRONUNCIATIONS) {
    out = out.replace(new RegExp(`\\b${orig}\\b`, 'gi'), phon);
  }
  // "gp" → "gold" for speech only (the chat log keeps "gp"). Substituted
  // amounts arrive as "152 gp"; spoken, that should be "152 gold", not
  // "gee pee". Mirrors the browser-TTS gp→gold in blindMode.js.
  out = out.replace(/\bgp\b/gi, 'gold');
  return out;
}

/** Pathfinder deity / divine-oath keywords. When a comma immediately
 *  follows an oath clause — "By Rovagug, those damn cards!" — the 11labs
 *  voices barely pause and the whole line runs together. We upgrade that
 *  comma to an ellipsis, which the models render as a noticeably longer
 *  beat. Scoped to oaths so ordinary commas keep their natural short
 *  pause. The match runs non-greedily up to the first comma and the
 *  clause class excludes sentence punctuation, so it never crosses a
 *  '.', '!', or '?' into an unrelated clause.
 *  Mirror in public/js/blindMode.js so the browser TTS fallback agrees. */
const DIVINE_OATH_WORDS = [
  'Sarenrae', 'Dawnflower', 'Sunlord', 'Cayden', 'Gorum', 'Shelyn',
  'Pharasma', 'Desna', 'Iomedae', 'Inheritor', 'Calistria', 'Torag',
  'Droskar', 'Brigh', 'Casandalee', 'Asmodeus', 'Norgorber', 'Nethys',
  'Rovagug', 'Lamashtu', 'Aroden', 'Tar-Baphon', 'Abadar', 'Jezelda',
  'Zon-Kuthon', 'Erastil', 'Urgathoa', 'Gozreh',
];
const _oathRe = new RegExp(`\\b(${DIVINE_OATH_WORDS.join('|')})([\\w\\s'-]*?),`, 'gi');
function lengthenDivinePauses(text) {
  return text.replace(_oathRe, '$1$2...');
}

/** Hard ceiling: tokens generated per minute per process, summed across
 *  all tables. Prevents a runaway loop or LLM-spam from blowing up the
 *  monthly bill. ~16k chars/min is generous; lower it if usage spikes. */
const RATE_LIMIT_CHARS_PER_MIN = parseInt(process.env.ELEVENLABS_RATE_LIMIT_CHARS || '16000', 10);
const _rateWindow = { startedAt: Date.now(), chars: 0 };
function rateAllowed(textLen) {
  const now = Date.now();
  if (now - _rateWindow.startedAt > 60_000) {
    _rateWindow.startedAt = now;
    _rateWindow.chars = 0;
  }
  if (_rateWindow.chars + textLen > RATE_LIMIT_CHARS_PER_MIN) return false;
  _rateWindow.chars += textLen;
  return true;
}

/** Generate audio for a single character line. Returns base64 MP3
 *  bytes ready to be attached to a socket payload, or null on any
 *  failure (caller continues without audio).
 *
 *  @param {string} text     The line to voice (trimmed, ≤200 chars in practice)
 *  @param {string} voiceId  An 11labs voice_id string
 *  @returns {Promise<string|null>}  base64-encoded MP3, or null
 */
async function synthesize(text, voiceId, settings) {
  if (!ENABLED) return null;
  if (!text || !voiceId) return null;
  const clean = lengthenDivinePauses(applyPronunciations(String(text).trim())).slice(0, 300);
  if (clean.length === 0) return null;
  if (!rateAllowed(clean.length)) {
    console.warn('[11labs] rate-limit hit; dropping line');
    return null;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: clean,
        model_id: MODEL,
        // Per-character overrides (if any) merge over the global defaults,
        // so a caller need only specify the keys it wants to change.
        voice_settings: { ...DEFAULT_VOICE_SETTINGS, ...(settings || {}) },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // 11labs returns helpful JSON on error; log the status only,
      // never the body (which may echo back data we don't want).
      console.warn(`[11labs] HTTP ${res.status}`);
      return null;
    }
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) return null;
    return Buffer.from(buf).toString('base64');
  } catch (e) {
    // AbortError, network failure — never bubble to caller.
    if (e?.name !== 'AbortError') {
      console.warn('[11labs] fetch failed:', e?.message || 'unknown');
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { synthesize, ENABLED };
