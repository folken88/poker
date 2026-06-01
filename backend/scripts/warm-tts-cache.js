#!/usr/bin/env node
/**
 * Pre-warm the TTS cache (src/util/ttsCache.js) by synthesizing the common,
 * highly-reusable short lines for every voiced character ONCE — their victory
 * lines (name-free) plus a small universal quick-reaction set. After this, those
 * lines never cost an 11labs call again. Lazy caching handles everything else
 * during normal play; this just makes the cache hot from day one.
 *
 * Run INSIDE the backend container (so the API key + DATA_DIR are present):
 *   docker exec folken-poker-backend node /app/scripts/warm-tts-cache.js        # dry-run: prints the plan, NO API calls
 *   docker exec folken-poker-backend node /app/scripts/warm-tts-cache.js --go   # actually synthesize + cache
 *
 * Options:
 *   --go           actually call 11labs (default: dry-run)
 *   --delay=<ms>   pace between calls (default 300; well under the 16k chars/min limit)
 *   --only=Name    restrict to one character (matches the voice-map nickname, case-insensitive)
 */
const { synthesize } = require('../src/util/elevenlabs');
const { CHARACTER_VOICES, settingsFor } = require('../src/bot/character_voices');
const { CHARACTER_FLAVOR } = require('../src/bot/banter');
const ttsCache = require('../src/util/ttsCache');

const args = process.argv.slice(2);
const GO = args.includes('--go');
const delayArg = args.find(a => a.startsWith('--delay='));
const DELAY = delayArg ? Math.max(0, parseInt(delayArg.split('=')[1], 10) || 0) : 300;
const onlyArg = args.find(a => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1].toLowerCase() : null;

// Universal short reactions any character may crack (shared quick-jab menu) —
// highest reuse, so worth warming for everyone. Kept short to bound the
// one-time cost; lazy caching catches the rest.
const UNIVERSAL = [
  'Fold.', 'Call.', 'Mine.', 'Cope.', 'Pathetic.', 'Brutal.',
  'About time.', 'No way.', 'Predictable.', 'Careful now.',
];

/** Pull the quoted VICTORY LINES out of a CHARACTER_FLAVOR blurb, skipping any
 *  with a [name] placeholder (those vary at runtime and can't be pre-warmed). */
function victoryLines(flavor) {
  if (!flavor) return [];
  const idx = flavor.indexOf('VICTORY LINES');
  if (idx < 0) return [];
  const out = [];
  const re = /"([^"]{1,60})"/g;
  let m;
  while ((m = re.exec(flavor.slice(idx)))) {
    const line = m[1].trim();
    if (line && !/\[name\]/i.test(line)) out.push(line);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const plan = [];
  for (const [nick, voiceId] of Object.entries(CHARACTER_VOICES)) {
    if (!voiceId) continue;                       // null = intentionally silent
    if (ONLY && nick.toLowerCase() !== ONLY) continue;
    const lines = Array.from(new Set([...victoryLines(CHARACTER_FLAVOR[nick]), ...UNIVERSAL]));
    if (lines.length) plan.push({ nick, voiceId, settings: settingsFor(nick) || null, lines });
  }

  const totalLines = plan.reduce((s, p) => s + p.lines.length, 0);
  const totalChars = plan.reduce((s, p) => s + p.lines.reduce((a, l) => a + l.length, 0), 0);
  console.log(`[warm] ${plan.length} voiced characters · ${totalLines} lines · ~${totalChars} 11labs characters total`);

  if (!GO) {
    console.log('[warm] DRY RUN — no 11labs calls made. Re-run with --go to synthesize.');
    for (const p of plan.slice(0, 6)) console.log(`  ${p.nick}: ${p.lines.length} lines`);
    if (plan.length > 6) console.log(`  …and ${plan.length - 6} more`);
    return;
  }

  let ok = 0, fail = 0, done = 0;
  for (const p of plan) {
    for (const line of p.lines) {
      const res = await synthesize(line, p.voiceId, p.settings); // miss → API + cache; hit → free
      if (res) ok++; else fail++;
      if (++done % 25 === 0) console.log(`[warm] ${done}/${totalLines}  (${ok} ok, ${fail} failed)`);
      if (DELAY) await sleep(DELAY);
    }
  }
  console.log(`[warm] complete: ${ok} synthesized/cached, ${fail} failed.`);
  console.log('[warm] cache stats:', JSON.stringify(ttsCache.getStats()));
})().catch((e) => { console.error('[warm] error', e); process.exit(1); });
