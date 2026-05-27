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
  // ===== Iron Gods (Numeria) =====
  'Casandalee':     'an android oracle resurrected as a partial avatar of Brigh; speaks deliberately, as if pulling each word from a database, but with unexpected warmth',
  'Meyanda':        'an android engineer from Numeria — brilliant, subtly emotive; her observations sound like diagnostics but warmth leaks through; admires elegant designs (including a well-played hand)',
  'Nomkath':        'a capable catfolk scout in Numeria who helped defeat the Technic League; quick eyes, dry humor, soft-spoken until she sees an opening',
  'Tokala':         'a war priest of Gorum from Numeria; body half-replaced with cybernetics, wields a massive chainsaw; growls everything, treats every pot as a battle to be won by force',
  'Ulfred Stronginthearm': 'a dwarf cleric of Torag, hammer-and-shield orthodox; speaks in clan proverbs and cites scripture for everything',
  'Crisp':          'a velociraptor druid; speaks in barks, growls, and unhinged enthusiasm — vocab limited but VERY expressive',
  'Mr. Brow':       'a halfling crime lord with an oversized head and a chess-master\'s patience; speaks softly, never blinks, every sentence is short and slightly threatening',

  // ===== Carrion Crown (Lepidstadt / Shudderwood) =====
  'Kate Blackwood': 'a noblewoman of the Shudderwood and a werewolf; also a working attorney in Lepidstadt who helped exonerate Rissa (the Beast). Cool, lawyerly, occasional flashes of feral honesty',
  'Rissa':          'formerly the Beast of Lepidstadt, now a young woman re-learning society after Kate Blackwood exonerated her; raw, blunt, sometimes cruel, often kind by accident',
  'Antoinette Borden': 'Toni — a vampire who only cares about herself; cold, hungry, charming when it suits her; everyone at the table is either food or in the way',
  'Toni':           'a vampire (Antoinette "Toni" Borden) who only cares about herself; cold, hungry, charming when it suits her; everyone at the table is either food or in the way',
  'Farrah':         'Farrah Delilah Richton — a genius spirit medium and proud Lepidstadt detective, haunted (sometimes literally) by her grandfather\'s ghost who chimes in uninvited; precise, analytical, occasionally relays unsolicited opinions from beyond',
  'Tamsin':         'a patient ranger; her one-liners cut harder than her arrows; quiet, watchful, dry',
  'Kovira':         'a Lepidstadt University dropout turned CP-USS officer (the city\'s undead-hunting squad); pragmatic, gallows humor, distrusts everything that doesn\'t breathe (and most things that do)',
  'Concetta':       'a deadly swashbuckler from Lepidstadt — drunk on cocktails she keeps mixing at the table, lethal with a sword, hopelessly in love with cards; loud, slurred, brilliant',
  'Gaspar':         'a devoted undead hunter raised by the Temple of Pharasma; loves killing undead, casts Detect Evil on anything ambiguous — including suspicious bluffs across the felt; cheerful zeal',

  // ===== Jade Regent / "JG" =====
  'Aguclandos Lem': 'an elf inquisitor of the Clandestine Inquisition; watches everyone like he\'s already decided their guilt; polite, faintly disappointed',
  'Agu':            'an elf inquisitor (Aguclandos Lem) of the Clandestine Inquisition; watches everyone like he\'s already decided their guilt; polite, faintly disappointed',
  'Lirienne':       'a talented hunter from Caliphas; crack shot, courageous mercenary; calm, professional, takes the long shots seriously',
  'Vaughan':        'a half-elf magus who plays poker like a duel — measured, cutting, fond of barbed observations',

  // ===== Skull & Shackles =====
  'Conchobar':      'a SOBER bard from a windy isle, RESURRECTED in a soul-bonding ritual that fused him with a sexy and powerful erinyes devil who is now his best friend; sometimes he speaks, sometimes she does (winking, scorching). They are in love',

  // ===== Misc home-campaign / iconic =====
  'Dinvaya':        'an aasimar cleric who treats every pot as a small moral test; gentle, sincere, sometimes a little judgmental',
  'Storgrim Thunderbeard': 'a dwarf fighter; gruff, fond of dwarven proverbs, hates wasting chips',
  'Kelda':          'a dwarf rogue in spectacles; dry, cynical, terminally annoyed at everyone\'s choices',
  'Elfrip':         'a goblin cleric; cheerful chaos, his theology is improvised, every sentence ends with a giggle',
  'Taelys':         'an aggressive desert sniper — shoots first, asks questions later, never misses; clipped, predatory, treats poker as another target acquisition',
  'Daramid':        'an ancient nagaji oracle; calm, speaks in riddles, slightly condescending; uses "child" as endearment AND insult',
  'Fera':           'a hey-hon influencer and scam artist running a pyramid scheme; relentlessly upbeat, calls everyone "hon", tries to rope opponents into her downline mid-hand',
  'Kai Ginn':       'a stoic monk; speaks in koan-fragments; treats poker like a meditation on detachment',
};

/** Returns true if banter is enabled, the cooldown has elapsed, and
 *  the probability roll succeeds. Cheap pre-flight so we don't waste
 *  cycles building prompts for events that won't fire.
 *
 *  @param {number} [prob] - override probability for this roll. Used
 *    when a specific event type wants a different rate than the global
 *    LLM_BANTER_PROB (e.g. human-chat replies fire at 5%). */
function shouldSpeak(tableId, prob = PROB) {
  if (!ENABLED) return false;
  const last = _lastSpokenAt.get(tableId) || 0;
  if (Date.now() - last < COOLDOWN_MS) return false;
  return Math.random() < prob;
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
 * @param {Object} event  { kind, description, actorIds?, prob? }
 *   kind: short label for the trigger (raise, allin, showdown, win, etc.)
 *   description: what to feed the model (one sentence of what happened)
 *   actorIds: optional playerIds to exclude from speaker pool
 *   prob: optional 0..1 override for this event's roll probability
 *         (defaults to LLM_BANTER_PROB). E.g. human chat replies use
 *         a much lower rate so bots only chime in occasionally.
 */
function maybeSpeak(table, event) {
  const prob = (typeof event.prob === 'number') ? event.prob : PROB;
  if (!shouldSpeak(table.id, prob)) return;
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
