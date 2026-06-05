/**
 * Persistent per-(character, event-kind) pool of previously-voiced "good lines"
 * (text + mp3), so a character can REPLAY a past line instead of paying for a
 * fresh LLM + 11labs call. Each saved line is tagged with its model VERSION
 * (v2/v3) and its specificity/subject so reuse only fires when it actually fits.
 *
 * Reuse policy (per design):
 *   - A line is "generic" (perfect-match-eligible for its event kind) unless it
 *     carries instance specifics — a number/gp amount or another character's
 *     name — or it was recorded against a particular SUBJECT (e.g. the monster
 *     in a dungeon "down" line).
 *   - When asked for a line for (char, kind, subject): if there are enough
 *     PERFECT-match candidates (generic lines, or specific lines whose subject
 *     matches the current moment), replay one with prob REUSE_PROB_MATCH
 *     (default 0.70). Otherwise mostly generate fresh — only replay a loose /
 *     uncertain candidate with REUSE_PROB_LOOSE (default 0.10).
 *
 * Storage: DATA_DIR/line-pool/<char>/<kind>/ — one mp3 per saved line (named
 * <version>_<sha1(text)>.mp3) plus an index.json of metadata. Capped per
 * (char,kind) by LINE_POOL_MAX (default 40), evicting oldest. Never throws to
 * the caller — every failure is swallowed and treated as "generate fresh".
 *
 * Env:
 *   LINE_POOL_ENABLED      '0' disables (default on)
 *   LINE_REUSE_PROB_MATCH  perfect-match reuse probability (default 0.70)
 *   LINE_REUSE_PROB_LOOSE  loose/uncertain reuse probability (default 0.10)
 *   LINE_POOL_MIN          min perfect-match candidates before match-reuse (default 3)
 *   LINE_POOL_MAX          max saved lines per (char,kind) (default 40)
 *   LINE_POOL_DIR          override the pool directory
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function clamp01(n) { return Math.max(0, Math.min(1, isNaN(n) ? 0 : n)); }

const ENABLED = process.env.LINE_POOL_ENABLED !== '0';
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const POOL_DIR = process.env.LINE_POOL_DIR || path.join(DATA_DIR, 'line-pool');
const REUSE_PROB_MATCH = clamp01(parseFloat(process.env.LINE_REUSE_PROB_MATCH || '0.70'));
const REUSE_PROB_LOOSE = clamp01(parseFloat(process.env.LINE_REUSE_PROB_LOOSE || '0.10'));
const MIN = Math.max(1, parseInt(process.env.LINE_POOL_MIN || '3', 10));
const MAX = Math.max(MIN, parseInt(process.env.LINE_POOL_MAX || '40', 10));

const stats = { reuseHits: 0, fresh: 0, records: 0, evictions: 0 };

// Names that make a line instance-SPECIFIC if they appear in it (it referenced a
// particular tablemate). Set by banter.js via setNames(); a digit also marks
// a line specific (a gp amount, a count — tied to one moment).
let _nameRe = null;
let _namesReSrc = null;   // escaped alternation source, for building a global matcher on demand
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function setNames(names) {
  const ns = (names || []).filter(n => n && String(n).length >= 3).map(escapeRe);
  _nameRe = ns.length ? new RegExp(`\\b(${ns.join('|')})\\b`, 'i') : null;
  _namesReSrc = ns.length ? ns.join('|') : null;
}
/** Distinct person-names (lowercased) that appear in `text`, per the current
 *  name set — empty when the line names nobody. A fresh RegExp per call keeps
 *  it free of lastIndex state; this runs only on reuse decisions. */
function _namesIn(text) {
  if (!_namesReSrc) return [];
  const re = new RegExp(`\\b(${_namesReSrc})\\b`, 'gi');
  const out = new Set();
  let m;
  while ((m = re.exec(String(text || ''))) !== null) out.add(m[1].toLowerCase());
  return [...out];
}
function _isSpecific(text) {
  if (/\d/.test(text)) return true;
  if (_nameRe && _nameRe.test(text)) return true;
  return false;
}

function _safe(s) { return (String(s || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)) || '_'; }
function _dir(char, kind) { return path.join(POOL_DIR, _safe(char), _safe(kind)); }
function _hash(text) { return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 24); }

// In-memory index cache: "char|kind" -> { loaded, entries:[{file,text,version,subject,specific,ts}] }
const _cache = new Map();
const _loading = new Map();   // in-flight first-load promises, so two callers can't double-load
const _locks = new Map();     // per-key mutation lock, so concurrent record()s don't clobber each other
const _ckey = (char, kind) => `${char}|${kind}`;

function _load(char, kind) {
  const k = _ckey(char, kind);
  const cached = _cache.get(k);
  if (cached && cached.loaded) return Promise.resolve(cached);
  if (_loading.has(k)) return _loading.get(k);
  const p = (async () => {
    const c = { loaded: true, entries: [] };
    try {
      const raw = await fsp.readFile(path.join(_dir(char, kind), 'index.json'), 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) c.entries = arr.filter(e => e && e.file && e.text);
    } catch (_) { /* no pool yet */ }
    _cache.set(k, c);
    _loading.delete(k);
    return c;
  })();
  _loading.set(k, p);
  return p;
}
// Serialize mutations for one key: each record() runs after the previous one
// resolves, so the read-modify-write (load → push → writeFile → saveIndex) is
// atomic and entries never clobber each other.
function _withLock(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  _locks.set(key, next.catch(() => {}));
  return next;
}
async function _saveIndex(char, kind, c) {
  try {
    const dir = _dir(char, kind);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'index.json'), JSON.stringify(c.entries));
  } catch (_) { /* best-effort */ }
}

/** Record a freshly-voiced line for later reuse (fire-and-forget). base64 = mp3. */
function record(char, kind, { text, version, subject, base64 } = {}) {
  if (!ENABLED || !char || !kind || !text || !base64) return;
  _withLock(_ckey(char, kind), async () => {
    try {
      const c = await _load(char, kind);
      const file = `${version || 'v2'}_${_hash(text)}.mp3`;
      if (c.entries.some(e => e.file === file)) return;   // already have this exact line+version
      const dir = _dir(char, kind);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, file), Buffer.from(base64, 'base64'));
      c.entries.push({ file, text, version: version || 'v2', subject: subject || null, specific: _isSpecific(text), ts: Date.now() });
      stats.records++;
      while (c.entries.length > MAX) {                    // evict oldest beyond the cap
        const old = c.entries.shift();
        try { await fsp.unlink(path.join(dir, old.file)); stats.evictions++; } catch (_) {}
      }
      await _saveIndex(char, kind, c);
    } catch (_) { /* best-effort */ }
  });
}

/** Decide whether to REPLAY a saved line. Returns { text, base64, version } or
 *  null (→ caller generates fresh). `subject` is the current event subject (e.g.
 *  the monster being fought), or null. */
async function choose(char, kind, subject) {
  if (!ENABLED || !char || !kind) return null;
  try {
    const c = await _load(char, kind);
    if (!c.entries.length) return null;
    const subj = subject || null;
    // Never replay a CUT-OFF line — its clipped audio breaks immersion. Only
    // consider entries that end on a real sentence terminator (defense in depth;
    // banter.js already refuses to record incomplete ones).
    const usable = c.entries.filter(e => /[.!?]["'”’)]?$/.test(String(e.text || '').trim()));
    if (!usable.length) return null;
    // NEVER replay a line that NAMES a person unless that exact person is the
    // current subject/addressee — otherwise a saved "facts, Tobias" gets said to
    // someone who isn't Tobias. When the addressee is unknown (table chatter,
    // subj=null), any person-named line is dropped here → the caller rerolls
    // (generates fresh). Lines that name nobody are unaffected.
    const subjL = subj ? String(subj).toLowerCase() : null;
    const addressable = usable.filter(e => {
      const names = _namesIn(e.text);
      if (!names.length) return true;
      return names.length === 1 && subjL != null && names[0] === subjL;
    });
    if (!addressable.length) return null;
    // perfect = generic lines, or specific lines whose subject matches the moment
    const perfect = addressable.filter(e => !e.specific || (e.subject && subj && e.subject === subj));
    const loose = addressable.filter(e => !perfect.includes(e));
    let bucket = null, prob = 0;
    if (perfect.length >= MIN) { bucket = perfect; prob = REUSE_PROB_MATCH; }
    else if (loose.length)     { bucket = loose;   prob = REUSE_PROB_LOOSE; }
    else if (perfect.length)   { bucket = perfect; prob = REUSE_PROB_LOOSE; }   // a few perfect but under MIN → rare reuse
    if (!bucket || !bucket.length || Math.random() >= prob) { stats.fresh++; return null; }
    const e = bucket[Math.floor(Math.random() * bucket.length)];
    const fp = path.join(_dir(char, kind), e.file);
    const buf = await fsp.readFile(fp);
    fsp.utimes(fp, new Date(), new Date()).catch(() => {});   // bump recency (LRU-ish)
    stats.reuseHits++;
    return { text: e.text, base64: buf.toString('base64'), version: e.version };
  } catch (_) { return null; }
}

function getStats() { const t = stats.reuseHits + stats.fresh; return { ...stats, decisions: t, reuseRate: t ? +(stats.reuseHits / t).toFixed(4) : 0, enabled: ENABLED }; }

module.exports = { record, choose, setNames, getStats, ENABLED };
