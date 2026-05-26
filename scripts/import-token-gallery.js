#!/usr/bin/env node
/**
 * Build the poker game's player-avatar gallery from the Foundry character
 * art library. We grab every "token_*" file modified in the last MAX_AGE_DAYS
 * (small square portraits — ideal for avatars) and copy them PERMANENTLY
 * into public/tokens/ along with a manifest.json the client uses to render
 * the avatar picker.
 *
 *   Source : F:/foundryvttstorage/foundryvtt-media/Art - Characters/
 *   Dest   : <repo>/public/tokens/
 *   Filter : basename starts with "token_" AND mtime within MAX_AGE_DAYS
 *
 * Run:  node scripts/import-token-gallery.js
 *
 * Re-running is safe — it overwrites existing tokens with the same name and
 * rewrites the manifest. We do NOT delete pre-existing tokens that no longer
 * qualify; if you want a clean rebuild, empty public/tokens/ first.
 */

const fs = require('fs');
const path = require('path');

const FOUNDRY_DIR    = 'F:/foundryvttstorage/foundryvtt-media/Art - Characters';
const OUT_DIR        = path.join(__dirname, '..', 'public', 'tokens');
const PC_MANIFEST    = path.join(__dirname, '..', 'public', 'assets', 'characters', 'manifest.json');
const VILLAINS_FILE  = path.join(__dirname, 'villains.json');
const MAX_AGE_DAYS   = parseInt(process.env.MAX_AGE_DAYS || '90', 10);
const CUTOFF_MS      = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const EXTS           = /\.(webp|png|jpg|jpeg)$/i;

fs.mkdirSync(OUT_DIR, { recursive: true });

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (EXTS.test(ent.name) && /^token_/i.test(ent.name)) {
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= CUTOFF_MS) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* unreadable file — skip */ }
    }
  }
  return out;
}

function slugify(s) {
  return s.toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Pull a human-readable display name from the filename. Strips the
 *  "token_" prefix + common race/sex tags + descriptive trailing junk so
 *  the player picker shows something tidy. Best-effort — falls back to
 *  the raw basename if nothing useful survives. */
function displayName(basename) {
  let stem = basename.replace(/\.[^.]+$/, '').replace(/^token_/i, '');
  // Drop stuff after a long underscore-separated tail of descriptors. Keep
  // first 3-4 tokens which usually carry the identity.
  const parts = stem.split('_').filter(Boolean);
  // Skip very common tag-only prefixes (race / sex / generic descriptors).
  const SKIP_TAGS = new Set([
    'human','elf','dwarf','halfling','gnome','goblin','hobgoblin','orc',
    'half','tiefling','aasimar','catfolk','kasatha','strix','dhampir',
    'samsaran','undead','ifrit','vampire','noble','female','male','m','f',
  ]);
  const meaningful = parts.filter(p => !SKIP_TAGS.has(p.toLowerCase()));
  const pick = (meaningful.length ? meaningful : parts).slice(0, 4);
  const name = pick.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  return name || basename;
}

console.log(`Scanning ${FOUNDRY_DIR}`);
console.log(`Filter: token_* with mtime within last ${MAX_AGE_DAYS} days (after ${new Date(CUTOFF_MS).toISOString()})`);

const candidates = walk(FOUNDRY_DIR);
console.log(`  ${candidates.length} recent token candidates`);

// Merge in the major-PC matches from public/assets/characters/manifest.json
// (built by scripts/import-vault-tokens.js). These are always included
// regardless of age so long-running campaign PCs are always in the gallery.
//   `pcMatches` is keyed by absolute source path so it can attach metadata
//   (PC name, race, class, player) to the corresponding output entry.
const pcMatches = new Map();
let pcCount = 0;
if (fs.existsSync(PC_MANIFEST)) {
  try {
    const pcs = JSON.parse(fs.readFileSync(PC_MANIFEST, 'utf8'));
    for (const pc of pcs) {
      if (!pc.sourceFile) continue;
      const abs = path.resolve(FOUNDRY_DIR, pc.sourceFile);
      if (!fs.existsSync(abs)) {
        console.warn(`  [pc miss] ${pc.name}: source not found at ${abs}`);
        continue;
      }
      const st = fs.statSync(abs);
      pcMatches.set(abs, { pc });
      // Add to the candidate list (deduped below) so the PC's token is
      // copied even if it falls outside the recency window.
      candidates.push({ path: abs, mtimeMs: st.mtimeMs, size: st.size });
      pcCount++;
    }
    console.log(`  +${pcCount} PC-matched tokens from vault manifest`);
  } catch (e) {
    console.warn(`  [pc manifest] could not read: ${e.message}`);
  }
} else {
  console.log(`  (no PC manifest at ${PC_MANIFEST} — run import-vault-tokens.js first if you want PCs in the gallery)`);
}

// Villains are processed in a SEPARATE pass below so that a villain
// sharing the same source file as a PC (e.g. "Texas Holden" pointing
// at the same swashbuckler art as the PC "Holden Aleistair") still
// emits as its own gallery entry. We just record them here.
const villains = [];
if (fs.existsSync(VILLAINS_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(VILLAINS_FILE, 'utf8'));
    const list = Array.isArray(data?.villains) ? data.villains : [];
    for (const v of list) {
      if (!v.source || !v.name) continue;
      const abs = path.resolve(FOUNDRY_DIR, v.source);
      if (!fs.existsSync(abs)) {
        console.warn(`  [villain miss] ${v.name}: source not found at ${abs}`);
        continue;
      }
      const st = fs.statSync(abs);
      villains.push({ villain: v, path: abs, mtimeMs: st.mtimeMs, size: st.size });
    }
    console.log(`  +${villains.length} hand-picked villains/major NPCs (separate pass)`);
  } catch (e) {
    console.warn(`  [villains] could not parse ${VILLAINS_FILE}: ${e.message}`);
  }
}

// Dedupe the PC/recent candidates by absolute path. A PC-match that also
// falls in the recency window would otherwise be copied twice.
{
  const seen = new Map();
  for (const c of candidates) {
    if (!seen.has(c.path)) seen.set(c.path, c);
  }
  candidates.length = 0;
  for (const c of seen.values()) candidates.push(c);
  console.log(`  ${candidates.length} unique PC/recent tokens after dedupe`);
}

const manifest = [];
const usedSlugs = new Set();
let copied = 0, skipped = 0;

// Sort newest-first so the gallery's natural order (and any cut-offs) put
// the freshest stuff at the top.
candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

for (const c of candidates) {
  const basename = path.basename(c.path);
  const ext = path.extname(basename).toLowerCase();
  const pcMatch = pcMatches.get(c.path);
  // Stable slug priority:
  //   1. PC slug from vault manifest         → /tokens/dinvaya.webp
  //   2. Fallback: slugified source filename → /tokens/token-…-…-…
  let baseSlug = pcMatch?.pc?.slug || slugify(basename.replace(ext, ''));
  if (!baseSlug) baseSlug = 'token-' + Math.random().toString(36).slice(2, 10);
  let slug = baseSlug;
  let n = 2;
  while (usedSlugs.has(slug)) { slug = `${baseSlug}-${n++}`; }
  usedSlugs.add(slug);

  const destName = slug + ext;
  const dest = path.join(OUT_DIR, destName);
  try {
    fs.copyFileSync(c.path, dest);
    copied++;
  } catch (e) {
    console.warn(`  [skip] ${basename}: ${e.message}`);
    skipped++;
    continue;
  }
  const entry = {
    id: slug,
    name: pcMatch?.pc?.name || displayName(basename),
    art: '/tokens/' + destName,
    sourceFile: path.relative(FOUNDRY_DIR, c.path).replace(/\\/g, '/'),
    mtime: new Date(c.mtimeMs).toISOString(),
    size: c.size,
  };
  if (pcMatch) {
    entry.pc        = true;
    entry.race      = pcMatch.pc.race || null;
    entry.class     = pcMatch.pc.class || null;
    entry.level     = pcMatch.pc.level || null;
    entry.player    = pcMatch.pc.player || null;
    entry.campaign  = pcMatch.pc.campaign || null;
  }
  manifest.push(entry);
}

// ---- Pass 2: villains / major NPCs ----
// Independent of the PC/recent dedupe — a villain can legitimately share
// its source file with a PC (Texas Holden ↔ Holden Aleistair) and must
// still emit as its own gallery entry with its own slug.
for (const v of villains) {
  const ext = path.extname(v.path).toLowerCase();
  let baseSlug = slugify(v.villain.name) || 'villain-' + Math.random().toString(36).slice(2, 10);
  let slug = baseSlug;
  let n = 2;
  while (usedSlugs.has(slug)) { slug = `${baseSlug}-${n++}`; }
  usedSlugs.add(slug);

  const destName = slug + ext;
  const dest = path.join(OUT_DIR, destName);
  try {
    fs.copyFileSync(v.path, dest);
    copied++;
  } catch (e) {
    console.warn(`  [skip villain] ${v.villain.name}: ${e.message}`);
    skipped++;
    continue;
  }
  manifest.push({
    id: slug,
    name: v.villain.name,
    art: '/tokens/' + destName,
    sourceFile: path.relative(FOUNDRY_DIR, v.path).replace(/\\/g, '/'),
    mtime: new Date(v.mtimeMs).toISOString(),
    size: v.size,
    villain: true,
    race: v.villain.race || null,
    class: v.villain.class || null,
    campaign: v.villain.campaign || null,
  });
}

// Alphabetize the manifest by display name so the gallery is browsable.
manifest.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`\nDone: ${copied} copied, ${skipped} skipped.`);
console.log(`Output: ${OUT_DIR}`);
console.log(`Manifest entries: ${manifest.length}`);
