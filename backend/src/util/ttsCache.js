/**
 * On-disk cache for synthesized 11labs MP3s — saves API characters (tokens)
 * by reusing the audio for any line a character has already voiced. Keyed by a
 * hash of (voiceId + model + voice settings + the EXACT cleaned text). Populated
 * lazily by synthesize(): a cache hit skips the 11labs call entirely.
 *
 * Strategy (per the design): cache EVERYTHING, bounded by a per-voice LRU + size
 * cap. Frequently reused lines (victory lines, one-word jabs, "Fold." / "Mine.")
 * stay hot — a hit "touches" the file's mtime — while one-off conversational
 * lines age out and get evicted, so the cache self-prunes the stuff that would
 * never be reused. Lives in the persistent data volume, so it survives restarts.
 *
 * Never throws to the caller: every failure is swallowed and treated as a miss,
 * so a broken cache can never break TTS — we just synthesize as usual.
 *
 * Env:
 *   TTS_CACHE_ENABLED          '0' disables (default on)
 *   TTS_CACHE_MAX_MB_PER_VOICE per-voice size cap in MB (default 80)
 *   TTS_CACHE_DIR              override the cache directory
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const ENABLED  = process.env.TTS_CACHE_ENABLED !== '0';
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const CACHE_DIR = process.env.TTS_CACHE_DIR || path.join(DATA_DIR, 'tts-cache');
const MAX_BYTES_PER_VOICE =
  Math.max(1, parseInt(process.env.TTS_CACHE_MAX_MB_PER_VOICE || '80', 10)) * 1024 * 1024;

const stats = { hits: 0, misses: 0, writes: 0, evictions: 0 };
let _lookups = 0;
const _writesSinceSweep = new Map(); // voiceId -> count, for throttled eviction

function _safeVoice(voiceId) {
  return String(voiceId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}
function _voiceDir(voiceId) { return path.join(CACHE_DIR, _safeVoice(voiceId)); }
function _filePath(voiceId, key) { return path.join(_voiceDir(voiceId), key + '.mp3'); }

/** Stable cache key (sha1 hex) for one synthesis request, or null if uncacheable.
 *  `settings` must be the FINAL merged voice_settings actually sent to 11labs,
 *  so a settings/model change naturally invalidates old audio. */
function keyFor(voiceId, model, settings, cleanText) {
  if (!ENABLED || !voiceId || !cleanText) return null;
  return crypto.createHash('sha1')
    .update(`${voiceId}|${model || ''}|${JSON.stringify(settings || {})}|${cleanText}`)
    .digest('hex');
}

/** Return base64 MP3 for a cache hit, or null for a miss. Touches mtime (LRU). */
async function get(voiceId, key) {
  if (!ENABLED || !key) return null;
  _lookups++;
  try {
    const fp = _filePath(voiceId, key);
    const buf = await fsp.readFile(fp);
    fsp.utimes(fp, new Date(), new Date()).catch(() => {}); // bump recency, non-blocking
    stats.hits++;
    _maybeLogStats();
    return buf.toString('base64');
  } catch (_) {
    stats.misses++;
    _maybeLogStats();
    return null;
  }
}

/** Store a base64 MP3 for later reuse (fire-and-forget). Throttled per-voice
 *  eviction keeps each voice under its size cap. */
function put(voiceId, key, base64) {
  if (!ENABLED || !key || !base64) return;
  (async () => {
    try {
      const dir = _voiceDir(voiceId);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(_filePath(voiceId, key), Buffer.from(base64, 'base64'));
      stats.writes++;
      const n = (_writesSinceSweep.get(voiceId) || 0) + 1;
      if (n >= 20) { _writesSinceSweep.set(voiceId, 0); _sweep(voiceId); }
      else { _writesSinceSweep.set(voiceId, n); }
    } catch (_) { /* best-effort */ }
  })();
}

/** Evict oldest-by-mtime files until the voice dir is back under ~90% of cap. */
async function _sweep(voiceId) {
  try {
    const dir = _voiceDir(voiceId);
    const names = await fsp.readdir(dir);
    const files = [];
    let total = 0;
    for (const name of names) {
      try {
        const st = await fsp.stat(path.join(dir, name));
        files.push({ name, size: st.size, mtime: st.mtimeMs });
        total += st.size;
      } catch (_) { /* skip */ }
    }
    if (total <= MAX_BYTES_PER_VOICE) return;
    files.sort((a, b) => a.mtime - b.mtime); // least-recently-used first
    const target = MAX_BYTES_PER_VOICE * 0.9;
    for (const f of files) {
      if (total <= target) break;
      try { await fsp.unlink(path.join(dir, f.name)); total -= f.size; stats.evictions++; } catch (_) {}
    }
  } catch (_) { /* best-effort */ }
}

function _maybeLogStats() {
  if (_lookups % 200 !== 0) return;
  const tot = stats.hits + stats.misses;
  const rate = tot ? (100 * stats.hits / tot).toFixed(1) : '0.0';
  console.log(`[tts-cache] ${stats.hits} hits / ${tot} lookups (${rate}% hit) · ${stats.writes} writes · ${stats.evictions} evicted`);
}

function getStats() {
  const tot = stats.hits + stats.misses;
  return { ...stats, lookups: tot, hitRate: tot ? +(stats.hits / tot).toFixed(4) : 0, enabled: ENABLED };
}

module.exports = { ENABLED, keyFor, get, put, getStats, CACHE_DIR };
