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
const ENDPOINT       = process.env.LLM_ENDPOINT || 'http://host.docker.internal:11434/api/generate';
const MODEL          = process.env.LLM_MODEL || 'gemma2:9b';
const COOLDOWN_MS    = parseInt(process.env.LLM_BANTER_COOLDOWN_MS || '18000', 10);
const PROB           = parseFloat(process.env.LLM_BANTER_PROB || '0.30');
const TIMEOUT_MS     = parseInt(process.env.LLM_BANTER_TIMEOUT_MS || '6000', 10);

// Per-table cooldown so banter doesn't spam every action.
const _lastSpokenAt = new Map();   // tableId -> ms timestamp

/** Very short character sheet used in the system prompt. Kept here
 *  rather than in db.js because it's prose/flavor, separate concern
 *  from the gameplay BOT_ROSTER. Missing entries fall back to a
 *  generic template using mode + intelligence. */
const CHARACTER_FLAVOR = {
  'Mr. Brow':       'a halfling crime lord with an oversized head and a chess-master\'s patience; speaks softly, never blinks',
  'Crisp':          'a velociraptor druid; speaks in barks, growls, and unhinged enthusiasm',
  'Vaughan':        'a half-elf magus who plays poker like a duel — measured, cutting',
  'Dinvaya':        'an aasimar cleric who treats every pot as a small moral test',
  'Kate Blackwood': 'a skinwalker magus with a cold smirk; speaks like a noir detective',
  'Kovira':         'a tiefling arcane trickster; sly, fond of barbed compliments',
  'Tamsin':         'a patient ranger; her one-liners cut harder than her arrows',
  'Concetta':       'a brash bravo; loud, theatrical, never doubts her hand',
  'Storgrim Thunderbeard': 'a dwarf fighter; gruff, fond of dwarven proverbs',
  'Kelda':          'a dwarf rogue in spectacles; dry, cynical, terminally annoyed',
  'Elfrip':         'a goblin cleric; cheerful chaos, his theology is improvised',
  'Taelys':         'a desert-wasteland sniper; clipped sentences, ominous pauses',
  'Lirienne':       'a moody ranger; speaks rarely, hits hard when she does',
  'Daramid':        'an ancient nagaji oracle; calm, riddling, slightly condescending',
  'Fera':           'a quiet patient drow; observes more than she speaks',
  'Gaspar':         'a roguish bard; quips constantly, half of them landing',
  'Rissa':          'an aggressive bravo; loud, vulgar, swaggering',
  'Conchobar':      'a drunk bard from a windy isle; rhyming and unreliable',
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

/** Build the prompt sent to the model. Strict output spec: one
 *  sentence, ≤20 words, no quotes, no narration. Character flavor
 *  is injected from CHARACTER_FLAVOR with a personality-based
 *  fallback. */
function buildPrompt(speaker, eventDescription) {
  const nick = speaker.player?.nickname || speaker.playerId;
  const flavor = CHARACTER_FLAVOR[nick]
    || `a ${speaker.player?.bot_mode || 'standard'}/${speaker.player?.bot_intelligence || 'average'} poker player`;
  const sys = [
    `You are ${nick}, ${flavor}.`,
    `You are watching a Texas Hold'em hand. Respond with ONE short in-character`,
    `comment, maximum 20 words. No quotes, no stage directions, no actions in`,
    `asterisks — just the words you'd say at the table. Stay in character.`,
  ].join(' ');
  return {
    prompt: `${sys}\n\nWhat just happened: ${eventDescription}\n\n${nick}:`,
    stop: ['\n', '"', '*'],
  };
}

/** Async fetch with timeout. Returns generated text, or null on
 *  any error (server down, malformed response, timed out). */
async function callLLM(promptSpec) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        prompt: promptSpec.prompt,
        stream: false,
        options: { temperature: 0.85, top_p: 0.9, num_predict: 50, stop: promptSpec.stop },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    // Ollama returns { response, ... }. Other servers may differ —
    // accept either `response` or OpenAI-style `choices[0].text`.
    const raw = json.response ?? json.choices?.[0]?.text ?? json.choices?.[0]?.message?.content ?? null;
    if (!raw || typeof raw !== 'string') return null;
    // Trim, strip leading character labels, cap length.
    let out = raw.trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^[A-Za-z][A-Za-z .']*?:\s*/, '')   // strip "Vaughan:" prefix if the model echoed it
      .split('\n')[0]                              // first line only
      .slice(0, 140);                              // hard char cap
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
  const promptSpec = buildPrompt(speaker, event.description);
  callLLM(promptSpec).then(line => {
    if (!line) return;
    const nick = speaker.player?.nickname || speaker.playerId;
    table.chat('banter', `💬 ${nick}: ${line}`);
  }).catch(() => { /* silent */ });
}

module.exports = { maybeSpeak };
