/**
 * Bot banter — ambient LLM-driven chat from non-acting bots.
 *
 *  When something noteworthy happens at the table (a big raise,
 *  an all-in, a bluff revealed at showdown, someone winning a
 *  monster pot) we ask a local LLM to write a single in-character
 *  line for a randomly-chosen seated bot who is NOT the actor.
 *  The result is posted to the chat as a 'banter' entry.
 *
 *  Why this design:
 *   - Heuristic decision engine (Bot.decide) stays untouched —
 *     numerical reasoning is its strength.
 *   - Latency irrelevant: banter is fire-and-forget, no game
 *     state depends on the reply.
 *   - LLM does what it's best at: personality + improvisation.
 *   - If the LLM is unreachable (no Ollama running, etc.) every
 *     call silently no-ops; no breakage.
 *
 *  Configuration (env vars):
 *    LLM_BANTER_ENABLED   '1' to enable. Default '0' (off until
 *                         you bring up your local model server).
 *    LLM_ENDPOINT         POST URL. Default Ollama's:
 *                         http://host.docker.internal:11434/api/generate
 *    LLM_MODEL            Model name. Default 'gemma2:9b'.
 *    LLM_BANTER_COOLDOWN_MS  Per-table min gap between banter
 *                         lines. Default 18000.
 *    LLM_BANTER_PROB      0..1, chance an eligible event triggers
 *                         a call. Default 0.30.
 *    LLM_BANTER_TIMEOUT_MS   Hard timeout on the HTTP call so a
 *                         stuck server can't pile up requests.
 *                         Default 6000.
 */

const ENABLED        = process.env.LLM_BANTER_ENABLED === '1';
// Use the /api/chat endpoint — it applies the model's chat template
// (system + user messages) correctly. /api/generate skips templating
// which leaves reasoning models like Gemma 4 stuck in their <thinking>
// preamble and never producing visible output.
const ENDPOINT       = process.env.LLM_ENDPOINT || 'http://host.docker.internal:11434/api/chat';
const MODEL          = process.env.LLM_MODEL || 'gemma4:e4b';
const COOLDOWN_MS    = parseInt(process.env.LLM_BANTER_COOLDOWN_MS || '18000', 10);
const PROB           = parseFloat(process.env.LLM_BANTER_PROB || '0.30');
const TIMEOUT_MS     = parseInt(process.env.LLM_BANTER_TIMEOUT_MS || '8000', 10);

// Per-table cooldown so banter doesn't spam every action.
const _lastSpokenAt = new Map();   // tableId -> ms timestamp

/** Very short character sheet used in the system prompt. Kept here
 *  rather than in db.js because it's prose/flavor, separate concern
 *  from the gameplay BOT_ROSTER. Missing entries fall back to a
 *  generic template using mode + intelligence. */
// Per-character flavor used in the system prompt. Keep each entry under
// ~200 chars — too much detail and the model loses the thread. Names
// must match BOT_ROSTER nicknames exactly (the lookup is by nickname).
const CHARACTER_FLAVOR = {
  // ===== Iron Gods (IG) =====
  'Casandalee':     'an android oracle resurrected as a partial avatar of Brigh; speaks deliberately, as if pulling each word from a database, but with unexpected warmth',
  'Meyanda':        'an android inquisitor-cleric; her prayers sound like system diagnostics; analytical, cold-precise, occasionally betrays awe',
  'Nomkath':        'a catfolk rogue carrying a humming Null Blade; soft-spoken, lethal patience, dry humor',
  'Tokala':         'a half-drow drifter; brooding, suspicious of everyone, very few words and most of them threats',
  'Ulfred Stronginthearm': 'a dwarf cleric of Torag, hammer-and-shield orthodox; speaks in clan proverbs and cites scripture for everything',
  'Crisp':          'a velociraptor druid; speaks in barks, growls, and unhinged enthusiasm — vocab limited but VERY expressive',
  'Mr. Brow':       'a halfling crime lord with an oversized head and a chess-master\'s patience; speaks softly, never blinks, every sentence is short and slightly threatening',

  // ===== Carrion Crown / Strange Aeons (Shudderwood-adjacent) =====
  'Kate Blackwood': 'a noblewoman of the Shudderwood and a werewolf; also a working attorney in Lepidstadt who helped exonerate Rissa (the Beast). Cool, lawyerly, occasional flashes of feral honesty',
  'Rissa':          'formerly the Beast of Lepidstadt, now a young woman re-learning society after Kate Blackwood exonerated her; raw, blunt, sometimes cruel, often kind by accident',
  'Antoinette Borden': 'a tightly-wound human magus from a Shudderwood family; precise, formal speech, deadly with both spell and blade',
  'Toni':           'a tightly-wound human magus (Antoinette "Toni" Borden) from a Shudderwood family; precise, formal speech, deadly with both spell and blade',
  'Farrah':         'a young human spiritualist (Farrah Delilah Richton) with a phantom steed and unsettling calm; sometimes shouts "cinnamon" for no reason, possibly a murderer',
  'Tamsin':         'a patient ranger; her one-liners cut harder than her arrows; quiet, watchful, dry',

  // ===== Jade Regent / "JG" =====
  'Aguclandos Lem': 'an elf inquisitor of the Clandestine Inquisition; watches everyone like he\'s already decided their guilt; polite, faintly disappointed',
  'Agu':            'an elf inquisitor (Aguclandos Lem) of the Clandestine Inquisition; watches everyone like he\'s already decided their guilt; polite, faintly disappointed',
  'Lirienne':       'a moody ranger; speaks rarely, hits hard when she does',
  'Vaughan':        'a half-elf magus who plays poker like a duel — measured, cutting, fond of barbed observations',

  // ===== Skull & Shackles =====
  'Conchobar':      'a SOBER bard from a windy isle, RESURRECTED in a soul-bonding ritual that fused him with a sexy and powerful erinyes devil who is now his best friend; sometimes he speaks, sometimes she does (winking, scorching). They are in love',
  'Concetta':       'a drunken swashbuckler always mixing a fresh cocktail at the table; deadly with a sword AND a hand of cards; loud, slurred, lethal',

  // ===== Misc home-campaign / iconic =====
  'Dinvaya':        'an aasimar cleric who treats every pot as a small moral test; gentle, sincere, sometimes a little judgmental',
  'Kovira':         'a tiefling arcane trickster; sly, fond of barbed compliments and obvious lies',
  'Storgrim Thunderbeard': 'a dwarf fighter; gruff, fond of dwarven proverbs, hates wasting chips',
  'Kelda':          'a dwarf rogue in spectacles; dry, cynical, terminally annoyed at everyone\'s choices',
  'Elfrip':         'a goblin cleric; cheerful chaos, his theology is improvised, every sentence ends with a giggle',
  'Taelys':         'a sniper from a desert wasteland; clipped sentences, ominous pauses, never explains',
  'Daramid':        'an ancient nagaji oracle; calm, speaks in riddles, slightly condescending; uses "child" as endearment AND insult',
  'Fera':           'a quiet patient drow; observes more than she speaks; when she does it\'s usually devastating',
  'Gaspar':         'a roguish bard; quips constantly, about half of them land; cheerful even when losing',
  'Kai Ginn':       'a stoic monk; speaks in koan-fragments; treats poker like a meditation on detachment',
};

/** Returns true if banter is enabled, the cooldown has elapsed, and
 *  the probability roll succeeds. Cheap pre-flight so we don't waste
 *  cycles building prompts for events that won't fire. */
function shouldSpeak(tableId) {
  if (!ENABLED) return false;
  const last = _lastSpokenAt.get(tableId) || 0;
  if (Date.now() - last < COOLDOWN_MS) return false;
  return Math.random() < PROB;
}

/** Pick a random eligible speaker:
 *    - currently seated
 *    - is a bot
 *    - not the actor of the event (no commenting on themselves)
 *    - not folded this hand (folded = not paying attention) */
function pickSpeaker(table, excludeIds) {
  const exclude = new Set(excludeIds || []);
  const candidates = [];
  for (const seat of table.seats) {
    if (seat.isEmpty() || !seat.isBot) continue;
    if (exclude.has(seat.playerId)) continue;
    // Skip folded players if there's a live hand.
    if (table.hand) {
      const p = table.hand.players.find(pp => pp.playerId === seat.playerId);
      if (p?.folded) continue;
    }
    candidates.push(seat);
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** Build the chat-format messages sent to the model. Strict output
 *  spec: one sentence, ≤20 words, no quotes, no narration. Character
 *  flavor is injected from CHARACTER_FLAVOR with a personality-based
 *  fallback. */
function buildMessages(speaker, eventDescription) {
  const nick = speaker.player?.nickname || speaker.playerId;
  const flavor = CHARACTER_FLAVOR[nick]
    || `a ${speaker.player?.bot_mode || 'standard'}/${speaker.player?.bot_intelligence || 'average'} poker player`;
  return [
    {
      role: 'system',
      content:
        `You are ${nick}, ${flavor}. You are watching a Texas Hold'em poker hand at a table. ` +
        `Reply with ONE short in-character line, maximum 20 words. No quotes, no stage directions, ` +
        `no asterisks, no actions — just the words you'd actually say out loud at the table. Stay in character.`,
    },
    {
      role: 'user',
      content: `What just happened: ${eventDescription}\n\nReact in character (one line).`,
    },
  ];
}

/** Async fetch with timeout. Returns generated text, or null on
 *  any error (server down, malformed response, timed out).
 *
 *  Uses Ollama's /api/chat which:
 *    - applies the model's chat template automatically
 *    - accepts `think: false` to skip Gemma 4 reasoning preamble
 *    - returns { message: { content, role, thinking? } } */
async function callLLM(messages) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        think: false,                              // skip reasoning preamble (Gemma 4)
        messages,
        options: { temperature: 0.9, top_p: 0.92, num_predict: 80 },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    // Tolerate both Ollama chat shape and OpenAI-style chat completions.
    const raw = json.message?.content
             ?? json.choices?.[0]?.message?.content
             ?? json.response
             ?? null;
    if (!raw || typeof raw !== 'string') return null;
    let out = raw.trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^[A-Za-z][A-Za-z .']*?:\s*/, '')   // strip "Mr. Brow:" prefix if echoed
      .split('\n')[0]                              // first line only
      .replace(/\s*\*[^*]+\*\s*/g, ' ')            // drop *actions in asterisks*
      .trim()
      .slice(0, 200);                              // hard char cap
    return out || null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget: maybe generate a banter line for the given event.
 *
 * @param {Object} table  the Table instance
 * @param {Object} event  { kind, description, actorIds? }
 *   kind: short label for the trigger (raise, allin, showdown, win, etc.)
 *   description: what to feed the model (one sentence of what happened)
 *   actorIds: optional playerIds to exclude from speaker pool
 */
function maybeSpeak(table, event) {
  if (!shouldSpeak(table.id)) return;
  const speaker = pickSpeaker(table, event.actorIds);
  if (!speaker) return;
  // Optimistically claim the cooldown slot — if the call fails the
  // cooldown still elapses naturally, and we avoid a thundering herd
  // of parallel calls if multiple events fire in quick succession.
  _lastSpokenAt.set(table.id, Date.now());
  const messages = buildMessages(speaker, event.description);
  callLLM(messages).then(line => {
    if (!line) return;
    const nick = speaker.player?.nickname || speaker.playerId;
    table.chat('banter', `💬 ${nick}: ${line}`);
  }).catch(() => { /* silent */ });
}

module.exports = { maybeSpeak };
