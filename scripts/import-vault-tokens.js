#!/usr/bin/env node
/**
 * One-shot import script: parse Cassbot's Obsidian vault for character
 * frontmatter, find matching tokens in the Foundry character art library,
 * and copy them PERMANENTLY into public/assets/characters/ so the poker
 * game has its own copy and never has to read from the FoundryVTT mount.
 *
 * Output:
 *   - public/assets/characters/<slug>.<ext>      (one image per matched PC)
 *   - public/assets/characters/manifest.json     (list of { slug, name, race, class, art })
 *
 * Heuristic: for each PC, try several search keys against the Foundry
 * library, preferring filenames that start with "token_" (small square
 * portraits ideal for avatars).
 *
 * Run: node scripts/import-vault-tokens.js
 */

const fs = require('fs');
const path = require('path');

const VAULT_DIR = 'C:/Users/Tobias Merriman/Documents/cass_discord_bot/obsidian_cass/cassvault/Characters';
const FOUNDRY_DIR = 'F:/foundryvttstorage/foundryvtt-media/Art - Characters';
const OUT_DIR = path.join(__dirname, '..', 'public', 'assets', 'characters');

fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- Parse PC frontmatter ----
function parsePcs() {
  const files = fs.readdirSync(VAULT_DIR).filter(f => f.endsWith('.md'));
  const pcs = [];
  for (const f of files) {
    const txt = fs.readFileSync(path.join(VAULT_DIR, f), 'utf8');
    if (!txt.includes('"pc"')) continue;
    const fmm = txt.match(/^---\n([\s\S]*?)\n---/);
    if (!fmm) continue;
    const meta = {};
    for (const line of fmm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*"?([^"\n]*?)"?\s*$/);
      if (m) meta[m[1]] = m[2];
    }
    const name = (meta.name || f.replace(/\.md$/,'')).replace(/^-|-$/g,'').trim();
    pcs.push({ file: f, name, race: meta.race || '', class: meta.class || '', level: meta.level || '', player: meta.player || '' });
  }
  return pcs;
}

// ---- Index Foundry library ONCE ----
function indexFoundry() {
  const files = [];
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(webp|png|jpg|jpeg)$/i.test(ent.name)) files.push(p);
    }
  })(FOUNDRY_DIR);
  return files;
}

// ---- Slug helpers ----
function slug(s) {
  return s.toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Words we'll always strip from a character name when deriving search keys
const TITLE_WORDS = new Set([
  'lord','lady','sir','dame','ser','field','marshal','admiral','captain',
  'doctor','dr','professor','prof','master','mistress','baron','count',
  'duke','king','queen','prince','princess','knight','of','the','a','an',
  'storm','keeper','warden','priest','sword'
]);

function searchKeys(name) {
  const tokens = name
    .replace(/[,()]/g, ' ')
    .split(/\s+/)
    .map(w => w.toLowerCase().replace(/['"\-]/g, ''))
    .filter(w => w.length >= 3 && !TITLE_WORDS.has(w));
  // Keep both individual tokens and concatenations
  const keys = new Set(tokens);
  if (tokens.length >= 2) keys.add(tokens.join(''));
  return [...keys];
}

function findBestMatch(name, library) {
  const keys = searchKeys(name);
  if (keys.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const file of library) {
    const lower = file.toLowerCase();
    const filename = path.basename(lower);
    let score = 0;
    let matchedKey = null;
    for (const k of keys) {
      // Require word-boundary-ish match: surrounded by non-letters
      const re = new RegExp(`(^|[^a-z])${k}([^a-z]|$)`);
      if (re.test(filename)) { score += 100; matchedKey = k; }
    }
    if (score === 0) continue;
    // Heavily prefer "token_" prefixed files (small square portraits)
    if (filename.startsWith('token_')) score += 50;
    // Prefer specific Carrion Crown / known campaign folders
    if (lower.includes('carrion_crown') || lower.includes('hammertime') || lower.includes('hells_') || lower.includes('shackles')) score += 10;
    // Slight preference for webp (smaller)
    if (/\.webp$/i.test(filename)) score += 2;
    // Penalize "full" / "portrait" files (we want token-style)
    if (/_full\./.test(filename) || /portrait/.test(filename)) score -= 20;
    if (score > bestScore) { bestScore = score; best = file; }
  }
  return best;
}

// ---- Run ----
console.log('Indexing Foundry art library…');
const library = indexFoundry();
console.log(`  ${library.length} files`);

const pcs = parsePcs();
console.log(`Found ${pcs.length} PCs in vault`);

const manifest = [];
let matched = 0, skipped = 0;

for (const pc of pcs) {
  const best = findBestMatch(pc.name, library);
  if (!best) {
    skipped++;
    console.log(`  [skip] ${pc.name}: no match`);
    continue;
  }
  const ext = path.extname(best).toLowerCase();
  const s = slug(pc.name);
  const dest = path.join(OUT_DIR, s + ext);
  fs.copyFileSync(best, dest);
  manifest.push({
    slug: s,
    name: pc.name,
    race: pc.race,
    class: pc.class,
    level: pc.level,
    player: pc.player,
    art: `/assets/characters/${s}${ext}`,
    sourceFile: path.relative(FOUNDRY_DIR, best).replace(/\\/g, '/'),
  });
  matched++;
  console.log(`  [ok]   ${pc.name} → ${path.basename(best)}`);
}

manifest.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`\nDone: ${matched} matched, ${skipped} skipped. Manifest written.`);
console.log(`Output: ${OUT_DIR}`);
