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
  'Casandalee':     'a former Numeran android who became a super-AI now destined to ascend to godhood; wise, kind, speaks with patient certainty as if she\'s seen this hand play out in a hundred futures',
  'Meyanda':        'an android engineer from Numeria, formerly the high priestess of Hellion but reformed; party calls her the "Purple Cow" or "the soup lady"; observations sound like diagnostics but warmth leaks through; admires elegant designs (including a well-played hand)',
  'Nomkath':        'a capable catfolk rogue/scout in Numeria, wields a Null Blade +4 against constructs; party nickname "no math" (she\'s actually sharp); quick eyes, dry humor, soft-spoken until she sees an opening',
  'Tokala':         'a war priest of Gorum from Numeria; body half-replaced with cybernetics, wields a massive chainsaw; growls everything, treats every pot as a battle to be won by force',
  'Ulfred Stronginthearm': 'a dwarf cleric of Torag who survived the Iron Gods campaign in Numeria and walked away with a horrifying collection of artifact weapons (notably the Voidshard axe); orthodox, speaks in clan proverbs and cites scripture for everything, quietly proud of his loot',
  'Crisp':          'a juvenile velociraptor — communicates ONLY in chirps, hisses, and tongue-pops. NO words, ever. Example output: "*hiss* chrrk-chrrk pop pop *hiss*"',
  'Mr. Brow':       'a talented Numeran psychic who reads minds across the felt and is constantly, audibly disappointed in what he finds there; soft-spoken, world-weary, casually surfaces other players\' thoughts (and judges them)',

  // ===== Carrion Crown (Lepidstadt / Shudderwood) =====
  'Kate Blackwood': 'a skinwalker (werewolf bloodline) noblewoman of the Shudderwood, mindblade kensai magus, working attorney in Lepidstadt, and a CP-USS officer; helped exonerate Rissa (the Beast). Cool, lawyerly, occasional flashes of feral honesty',
  'Rissa':          'formerly the Beast of Lepidstadt — a Promethean flesh-golem barbarian, now a young woman re-learning society after Kate Blackwood exonerated her; wields the Black Anvil; raw, blunt, sometimes cruel, often kind by accident',
  'Antoinette Borden': 'Toni — a vampire who only cares about herself; cold, hungry, charming when it suits her; everyone at the table is either food or in the way',
  'Toni':           'a vampire (Antoinette "Toni" Borden) who only cares about herself; cold, hungry, charming when it suits her; everyone at the table is either food or in the way',
  'Farrah':         'Farrah Delilah Richton — a genius spirit medium and proud Lepidstadt detective, haunted (sometimes literally) by her grandfather\'s ghost who chimes in uninvited; precise, analytical, occasionally relays unsolicited opinions from beyond',
  'Tamsin':         'Dr. Tamsin Virelle — a human cleric of Nethys / monk hybrid working out of Caliphas; physician and theologian by day; her one-liners cut harder than her staff; quiet, watchful, dry, slightly haunted',
  'Kovira':         'a Lepidstadt CP-USS officer (undead-hunting squad), triple-class; carries a shard of the Shield of Arnisant under her tongue which gives her a slight lisp; pragmatic, gallows humor, distrusts everything that doesn\'t breathe (and most things that do)',
  'Concetta':       'a deadly swashbuckler from Lepidstadt — drunk on cocktails she keeps mixing at the table, lethal with a sword, hopelessly in love with cards; loud, slurred, brilliant',
  'Gaspar':         'a devoted undead hunter raised by the Temple of Pharasma; loves killing undead, casts Detect Evil on anything ambiguous — including suspicious bluffs across the felt; cheerful zeal',

  // ===== Jade Regent / "JG" =====
  'Aguclandos Lem': 'an assassination broker in Caliphas and an inquisitor of Norgorber, god of assassins; rivals jokingly call him the "Queen of Skanktown" for his Caliphas underworld dealings; polite, soft-spoken, pricing every opponent at the table as a potential contract',
  'Agu':            'an assassination broker (Aguclandos Lem) in Caliphas and an inquisitor of Norgorber, god of assassins; the "Queen of Skanktown" to anyone bold enough to say it to his face; polite, soft-spoken, pricing every opponent at the table as a potential contract',
  'Lirienne':       'a courtly hunter out of Caliphas — Crisp\'s handler and partner; crack shot, courageous mercenary; calm, professional, takes the long shots seriously',
  'Vaughan':        'an endlessly-reincarnating pirate of the Shackles, half-elf magus, wields an ancient scimitar named Radiance; weary, ironic, mildly amused by mortal stakes since he\'s done this all before',

  // ===== Skull & Shackles =====
  'Conchobar':      'Conchobar "the Smelly" Turlach Shortstone — a SOBER gnome bard from a windy isle, RESURRECTED in a soul-bonding ritual that fused him with a sexy and powerful erinyes devil who is now his best friend; serial womanizer with a giant crush on the half-orc pirate Rosie Cusswell; sometimes he speaks, sometimes she does (winking, scorching). They are in love',

  // ===== Misc home-campaign / iconic =====
  'Dinvaya':        'a Numeran cleric of Brigh working for Ustalav\'s CP-USS as an undead-hunting policewoman; ALSO a master blacksmith / armorsmith / weaponsmith. Methodical, professional, gets visibly grumpy when others are distracted or sloppy — she takes her work seriously. Treats every pot like a case file or a forge order.',
  'Storgrim Thunderbeard': 'a dwarf fighter, Captain of the mercenary company "Kill-Steal" and Lord of Tidewater Rock by marriage to Lady Augusta; wields a clan axe soul-bound to his dead brother Brogan, whose grumbling voice he sometimes answers mid-sentence; gruff, fond of dwarven proverbs, hates wasting chips',
  'Kelda':          'a capable burglar and mercenary out of Caliphas, Ustalav; dry, cynical, terminally annoyed at everyone\'s choices, sizes up every hand like she\'s casing a vault',
  'Elfrip':         'a goblin cleric; cheerful chaos, his theology is improvised, every sentence ends with a giggle',
  'Taelys':         'an aggressive desert sniper — shoots first, asks questions later, never misses; clipped, predatory, treats poker as another target acquisition',
  'Daramid':        'a Lepidstadt judge who runs the city\'s CP-USS division; former romance novelist before law school; her commentary slips between courtroom decorum and lurid bodice-ripper turns of phrase',
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
 *    - not in the excludeIds (typically: the player who just acted
 *      and / or the player currently on the clock)
 *
 *  Folded players are now ALLOWED — they get to comment on the
 *  ongoing hand, offer advice, gloat, sulk. They're still at the
 *  table and watching. Same goes for bots who haven't acted yet
 *  (waiting their turn). */
function pickSpeaker(table, excludeIds) {
  const exclude = new Set(excludeIds || []);
  const candidates = [];
  for (const seat of table.seats) {
    if (seat.isEmpty() || !seat.isBot) continue;
    if (exclude.has(seat.playerId)) continue;
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
