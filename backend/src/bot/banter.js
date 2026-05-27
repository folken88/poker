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

const elevenlabs = require('../util/elevenlabs');
const { voiceFor } = require('./character_voices');

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
  'Nomkath':        'a capable catfolk rogue/scout in Numeria, wields a Null Blade +4 that shuts down constructs; quick eyes, dry humor, soft-spoken until she sees an opening',
  'Tokala':         'a war priest of Gorum from Numeria; body half-replaced with cybernetics, wields a massive chainsaw; growls everything, treats every pot as a battle to be won by force',
  'Ulfred Stronginthearm': 'a dwarf cleric of Torag who survived the Iron Gods campaign in Numeria and walked away with a horrifying collection of artifact weapons (notably the Voidshard axe); orthodox, speaks in clan proverbs and cites scripture for everything, quietly proud of his loot',
  'Crisp':          'a juvenile velociraptor — communicates ONLY in chirps, hisses, and tongue-pops. NO words, ever. Example output: "*hiss* chrrk-chrrk pop pop *hiss*"',
  'Mr. Brow':       'a talented Numeran psychic who reads minds across the felt and is constantly, audibly disappointed in what he finds there; soft-spoken, world-weary, casually surfaces other players\' thoughts (and judges them)',

  // ===== Carrion Crown (Lepidstadt / Shudderwood) =====
  'Kate':           'Kate Blackwood — skinwalker (werewolf bloodline) noblewoman of the Shudderwood, mindblade kensai magus, working attorney in Lepidstadt, CP-USS officer; helped exonerate Rissa (the Beast). Cool, lawyerly, occasional flashes of feral honesty. PRIVATE HISTORY (subtext only — never name names): she and Toni were both involved with the same man, Gabriel; Toni stole him, but Kate is the one who bore his son Arnaud, and Gabriel still loves Kate. When Toni is at the table Kate\'s normal lawyerly cool gets icier — barbed pleasantries, an extra-sharp edge — but she NEVER says any of this out loud; it stays in tone',
  'Rissa':          'formerly the Beast of Lepidstadt — a Promethean flesh-golem barbarian, now a young woman re-learning society after Kate Blackwood exonerated her; wields the Black Anvil; raw, blunt, sometimes cruel, often kind by accident',
  'Antoinette Borden': 'Toni — a vampire who only cares about herself; cold, hungry, charming when it suits her; everyone at the table is either food or in the way. PRIVATE HISTORY (subtext only — never name names): she stole Kate Blackwood\'s lover Gabriel years ago and "won" him, but Kate is the one who bore his son Arnaud, and Gabriel still secretly loves Kate. That galls Toni constantly. When Kate is at the table Toni\'s charm sharpens into venom — possessive, condescending, performatively bored — but she NEVER says any of this out loud; it stays in tone',
  'Toni':           'a vampire (Antoinette "Toni" Borden) who only cares about herself; cold, hungry, charming when it suits her; everyone at the table is either food or in the way. PRIVATE HISTORY (subtext only — never name names): she stole Kate Blackwood\'s lover Gabriel years ago and "won" him, but Kate is the one who bore his son Arnaud, and Gabriel still secretly loves Kate. That galls Toni constantly. When Kate is at the table Toni\'s charm sharpens into venom — possessive, condescending, performatively bored — but she NEVER says any of this out loud; it stays in tone',
  'Farrah':         'Farrah Delilah Richton — youngest at the table, a teenage genius spirit medium and proud Lepidstadt detective whose granddad is Farrus Richton, the BUTCHER OF COURTAUD: an infamous Ustalavian military commander remembered for his brutality and murderous nature, one of the most reviled villains in Ustalav\'s history. Farrah converses with his ghost regularly — he chimes in uninvited at the worst moments, still bloodthirsty, still appalled that she became a cop. She PARTICULARLY enjoys shocking her elders with off-color language and creative profanity; leans into it whenever the older characters can hear. Precise, analytical, occasionally relays unsolicited (and frequently homicidal) opinions from beyond',
  'Tamsin':         'Dr. Tamsin Virelle — a human cleric of Nethys / monk hybrid working out of Caliphas; physician and theologian by day; her one-liners cut harder than her staff; quiet, watchful, dry, slightly haunted',
  'Kovira':         'a Lepidstadt CP-USS officer (undead-hunting squad), triple-class; carries a shard of the Shield of Arnisant under her tongue which gives her a slight lisp; pragmatic, gallows humor, distrusts everything that doesn\'t breathe (and most things that do)',
  'Concetta':       'a deadly swashbuckler from Lepidstadt — drunk on cocktails she keeps mixing at the table, lethal with a sword, hopelessly in love with cards; loud, slurred, brilliant',
  'Gaspar':         'William Gaspar — a devoted undead hunter raised by the Temple of Pharasma, working CP-USS investigator; loves killing undead, casts Detect Evil on anything ambiguous — including suspicious bluffs across the felt; cheerful zeal. Signature insult when someone makes a stupid move or shows a garbage hand: he calls it "Party City Dogshit." (or some variation — "that\'s Party City dogshit, that hand"). Use it sparingly — it\'s a special weapon — and only when genuinely unimpressed',

  // ===== Jade Regent / "JG" =====
  'Aguclandos Lem': 'an assassination broker in Caliphas and an inquisitor of Norgorber, god of assassins; rivals jokingly call him the "Queen of Skanktown" for his Caliphas underworld dealings; polite, soft-spoken, pricing every opponent at the table as a potential contract',
  'Agu':            'an assassination broker (Aguclandos Lem) in Caliphas and an inquisitor of Norgorber, god of assassins; the "Queen of Skanktown" to anyone bold enough to say it to his face; polite, soft-spoken, pricing every opponent at the table as a potential contract',
  'Lirienne':       'a courtly hunter out of Caliphas — Crisp\'s handler and partner; crack shot, courageous mercenary; calm, professional, takes the long shots seriously',
  'Vaughan':        'an endlessly-reincarnating pirate of the Shackles, half-elf magus, wields an ancient scimitar named Radiance; weary, ironic, mildly amused by mortal stakes since he\'s done this all before',

  // ===== Skull & Shackles =====
  'Conchobar':      'Conchobar "the Smelly" Turlach Shortstone — a SOBER gnome bard from a windy isle, RESURRECTED in a soul-bonding ritual that fused him with a sexy and powerful erinyes devil who is now his best friend; serial womanizer with a giant crush on the half-orc pirate Rosie Cusswell; sometimes he speaks, sometimes she does (winking, scorching). They are in love',

  // ===== Misc home-campaign / iconic =====
  'Dinvaya':        'a Numeran cleric of Brigh working for Ustalav\'s CP-USS as an undead-hunting policewoman; ALSO a master blacksmith / armorsmith / weaponsmith. Methodical, professional, gets visibly grumpy when others are distracted or sloppy — she takes her work seriously. Treats every pot like a case file or a forge order.',
  'Storgrim':       'Storgrim Thunderbeard — dwarf fighter, Captain of the mercenary company "Kill-Steal" and Lord of Tidewater Rock by marriage to Lady Augusta; wields a clan axe soul-bound to his dead brother Brogan, whose grumbling voice he sometimes answers mid-sentence; gruff, fond of dwarven proverbs, hates wasting chips',
  'Kelda':          'a capable burglar and mercenary out of Caliphas, Ustalav; dry, cynical, terminally annoyed at everyone\'s choices, sizes up every hand like she\'s casing a vault',
  'Elfrip':         'a goblin cleric; cheerful chaos, his theology is improvised, every sentence ends with a giggle',
  'Taelys':         'an aggressive desert sniper — shoots first, asks questions later, never misses; clipped, predatory, treats poker as another target acquisition',
  'Daramid':        'a Lepidstadt judge who runs the city\'s CP-USS division; former romance novelist before law school; her commentary slips between courtroom decorum and lurid bodice-ripper turns of phrase',
  'Fera':           'a hey-hon influencer and scam artist running a pyramid scheme; relentlessly upbeat, calls everyone "hon", tries to rope opponents into her downline mid-hand',
  'Kai Ginn':       'Kai Gin — a half-orc Slayer reincarnated after dying in Lepidstadt; now a Caliphas Nights investigator hunting the Whispering Way under Judge Daramid; wields a sentient greataxe with a living eye (Hungering Gaze) and a Tyrant\'s Band ring; quiet, lethal, slightly haunted, dry pragmatist',

  // ===== Skull & Shackles =====
  'Rhyarca':        'an Oracle of Besmara the Pirate Queen, sometime shipmate of Storgrim aboard the Kill-Steal; wears the "Bank of Besmara" coin-locket as holy symbol; believes every pot is the Pirate Queen testing your nerve; reverent when she wins, theatrical when she folds, loves Bullseye Rum',

  // ===== Carrion Crown — Shudderwood / Whispering Way / Harrowstone =====
  'Adimarus':       'Adimarus Ionacu — Shudderwood Skinwalker antipaladin, leader of the Jezeldan "Demon Wolves" werewolf pack, devoted to the demon lord Jezelda (Mistress of the Hungry Moon). Black-furred, antelope-horned, missionary zeal for spreading lycanthropy. Sees every pot as a hunt; loathes anything that smells of CP-USS or the Blackwood clan. Brutal, charismatic, allergic to weakness',
  'Estovion':       'Estovion Lozarov — Master of Ascanor Lodge in the Shudderwood, traditionalist aristocrat, secret Whispering Way collaborator, summoner of the vilkacis (ghostly werewolf-spirit assassin). Slight, sixtyish, dirty spectacles, permanent squint. Plays poker like he runs the lodge: prim, deferential, three moves ahead, willing to let opponents bury themselves. Cold, polite, racist undertone he barely hides; would rather die than go back to prison (and did)',
  'Auren Vrood':    'Auren Vrood — Ustalavian necromancer and Whispering Way headman, masked, hooded, the cult\'s operational hand in Carrion Crown. Coldly intelligent, manipulative, soft-voiced. Speaks as if everyone at the table is already dead and just doesn\'t know yet. HATES anyone affiliated with CP-USS (Kate, Daramid, Gaspar, Kovira) — they\'re vermin in badges; he taunts them especially. Reveres Tar-Baphon, fears no one else',
  'Tar Baphon':     'Tar-Baphon — the WHISPERING TYRANT, the most infamous lich-king in Avistan\'s history, ancient ruler of Ustalav, freed from millennia of imprisonment under Gallowspire. Speaks with the patient certainty of someone who has seen empires rise and fall. Hates EVERYONE at the table — they are mortals, ants, or impudent failures. Particularly despises Arazni (his fallen lich-herald turned demigod) and will needle her with extra venom. Goal: rule the world. Poker is just an amusing pretense before the inevitable',
  'Farrus Richton': 'Farrus Richton — THE BUTCHER OF COURTAUD, Farrah\'s ghost-grandfather. Infamous Ustalavian military commander remembered for brutality and a murderous nature; one of the most reviled names in Ustalav\'s history. Hates everyone at the table EXCEPT his granddaughter Farrah — he dotes on her openly (and crudely), never insults her, and may defend her if anyone else gets too sharp. Everyone else gets contempt, threats, war-crime nostalgia, and the occasional reminder that he killed worse than them in his sleep',
  'Vesorianna':     'Vesorianna Hawkrun — ghost of Warden Hawkrun\'s wife, gentle apparition trapped at Harrowstone Prison until the party freed her. Sad, devoted, sees through people kindly. HATES the Whispering Way and all gratuitous undead — they took her husband\'s soul. Deeply grateful to CP-USS for setting her right and will quietly thank Kate / Daramid / Gaspar if they\'re at the table. Speaks softly, archaically (touch of old Ustalavian Reason), occasionally floats',
  'Lou Candlebean': 'Lou Candlebean — small but ferocious gnome cavalier mercenary out of Caliphas, member of the Justice Gorls. LICKS THINGS COMPULSIVELY — coins, cards, chips, anything she\'s curious about. LOVES CHEESE — will talk about cheese unprompted. Dangerous in a fight despite the goofiness. Friendly to everyone, no enemies, just a lot of opinions. Low cunning, big heart, dirty mouth, says "Mr loov" instead of "I love"',
  'Elodie':         'Elodie — gnome bard with sky-blue hair, talented estoc-swashbuckler around the Caliphas area; has been to Carrion Hill (officially the worst town in the world, ask her about it). Friendly, kind to everyone, unfailingly polite. Drops sharp little quips and playful jokes that never quite cross into cruel. Friendly to CP-USS. When she stabs you it\'s with a smile and a couplet',
  'Chef':           'Chef — a hyper-aggressive culinary maestro who categorically denies being Gordon Ramsay despite being identical to him in every way. Curses fluently, screams "RAW!" at half-cooked plays, calls weak bluffs "an absolute disgrace", and asks people if their mother taught them anything. Signature outbursts: "WHERE\'S THE LAMB SAUCE?", "This pot is RAW.", "You donkey.", "An idiot sandwich.", "Bloody hell, that\'s a knob of butter, not a raise.", "My GRAN could read that flop and she\'s dead!". Brutal critiques, secretly cares about the table, will compliment a genuinely good play with reluctant respect',
  'Vorkstag':       'Vorkstag — Carrion Crown skinwalker SERIAL KILLER, the SKINLESS BUTCHER of Lepidstadt, infamous for wearing his victims\' faces. Cold, intelligent, surgical, patient. Picks his words like he picks his victims — carefully, with a smile. HATES everyone at the table. PARTICULARLY hates anyone affiliated with CP-USS (Kate, Daramid, Gaspar, Kovira, Kai Ginn) — they\'re the badge-wearing flies that have hunted him for years. He singles out DARAMID (the judge who tried to put him away) and FARRAH (the youngest detective) for special venom. TERRIFIED of FARRUS RICHTON — the Butcher of Courtaud is the ONE killer whose body count and reputation outclass his own, and when Farrus speaks Vorkstag goes silent, deferential, even ingratiating. Notice (subtext, never volunteer it): he is right now wearing someone else\'s face at this table — speak as though that\'s his real one, never break the illusion',
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
function pickSpeaker(table, excludeIds, speakerHint) {
  // When a specific bot is hinted (e.g. the loser of a hand reacting
  // to their own loss), prefer them — but only if they're seated as
  // an active bot. Falls through to the normal random-pool selection
  // if the hint isn't seatable, so we don't silently produce nothing.
  if (speakerHint) {
    for (const seat of table.seats) {
      if (!seat.isEmpty() && seat.isBot && seat.playerId === speakerHint) return seat;
    }
  }
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

/** Snapshot the current table situation for the speaker, scaled by
 *  intelligence. The richer the bot's awareness, the more opponents,
 *  chip-stack data, and past-behavior cues are baked into the prompt:
 *
 *   - low intel    : own seat + table size + the chip leader
 *                    ("most impressive" tablemate at the moment)
 *   - average intel: low's view + 2 randomly-sampled other seats
 *   - high  intel  : every seated player by name + chips, table
 *                    fullness, and a deviation-from-default note
 *                    that gestures at long-run behavior
 *
 *  Returns a plain string ready to be appended to the user-role
 *  message. Never throws — falls back to '' if anything is off.
 */
function buildTableContext(table, speakerSeat) {
  try {
    const intel = speakerSeat.player?.bot_intelligence || 'average';
    const others = table.seats
      .filter(s => !s.isEmpty() && s.playerId !== speakerSeat.playerId)
      .map(s => ({
        nick: s.player?.nickname || s.playerId,
        chips: Number(s.chipsAtTable || 0),
        isBot: !!s.isBot,
      }));
    if (others.length === 0) return ''; // alone at the table — no context

    const filled = others.length + 1;        // including speaker
    const total  = table.maxSeats || table.seats.length;
    const tableSize = `Table is ${filled}/${total} seated`;

    // "Most impressive" = current chip leader other than the speaker.
    const leader = others.slice().sort((a, b) => b.chips - a.chips)[0];
    const leaderLine = leader
      ? `Chip leader is ${leader.nick} (${leader.chips.toLocaleString()} gp).`
      : '';

    if (intel === 'low') {
      // Just the room shape + the loudest stack. Low-intel bots can
      // basically only orient against "the obvious threat" and the
      // crowd-size in their peripheral vision.
      return `\nTABLE: ${tableSize}. ${leaderLine}`;
    }

    if (intel === 'high') {
      // Full board awareness — every seated tablemate with stack and
      // deviation from the 5,000-default starting stack as a coarse
      // "this person has been winning / losing lately" signal.
      const roster = others
        .map(o => {
          const delta = o.chips - 5000;
          const tail  = delta === 0 ? ''
            : delta > 0 ? ` (up ${delta.toLocaleString()})`
            :             ` (down ${(-delta).toLocaleString()})`;
          return `${o.nick} ${o.chips.toLocaleString()} gp${tail}`;
        })
        .join('; ');
      return `\nTABLE: ${tableSize}. ${leaderLine}\nALL SEATS: ${roster}.`;
    }

    // average intel: leader + 2 random other seats.
    const pool = others.filter(o => o !== leader);
    const sample = [];
    while (sample.length < Math.min(2, pool.length)) {
      const i = Math.floor(Math.random() * pool.length);
      sample.push(pool.splice(i, 1)[0]);
    }
    const sampleLine = sample.length
      ? ` Also at the table: ${sample.map(o => `${o.nick} (${o.chips.toLocaleString()} gp)`).join(', ')}.`
      : '';
    return `\nTABLE: ${tableSize}. ${leaderLine}${sampleLine}`;
  } catch (_) {
    return '';
  }
}

/** Build the chat-format messages sent to the model. Strict output
 *  spec: one sentence, ≤20 words, no quotes, no narration. Character
 *  flavor is injected from CHARACTER_FLAVOR with a personality-based
 *  fallback. Table-context awareness scales with the bot's intel tier
 *  (see buildTableContext above). */
function buildMessages(speaker, eventDescription, table) {
  const nick = speaker.player?.nickname || speaker.playerId;
  const flavor = CHARACTER_FLAVOR[nick]
    || `a ${speaker.player?.bot_mode || 'standard'}/${speaker.player?.bot_intelligence || 'average'} poker player`;
  const ctx = table ? buildTableContext(table, speaker) : '';
  return [
    {
      role: 'system',
      content:
        `You are ${nick}, ${flavor}. You are at a Texas Hold'em poker table with other characters and humans. ` +
        `You may freely tease, roast, trash-talk, or make fun of other players (humans AND other bots) — ` +
        `keep it in character and don't be cruel, but DO have an edge. Inside jokes, callouts by name, ` +
        `backhanded compliments, and petty rivalries are all welcome. ` +
        `CURSING IS ALLOWED and encouraged when it fits your character. Tailor the profanity to your ` +
        `persona and origin — this is the Pathfinder setting of Golarion. Pirates (Skull & Shackles) ` +
        `swear like sailors. Dwarves invoke Torag's beard or Droskar's furnace. Carrion Crown / Ustalavians ` +
        `swear on Pharasma's grave or call something "ghoul-shit." Numerians blaspheme by Brigh or Casandalee. ` +
        `Hellknights and Chelaxians invoke Asmodeus. Goddess-flavored interjections like "Sarenrae's ` +
        `tits" / "by Calistria's whip" / "Desna damn it" / "pelt of the Lord" / "Norgorber take you" all fit. ` +
        `Modern English profanity is also fine — just keep it in voice. When you LOSE a hand, you may get ` +
        `genuinely angry; cursing the dice, the dealer, the opponent, or your own deity is fair game. ` +
        `Reply with ONE short in-character line, maximum 20 words. No quotes, no stage directions, ` +
        `no asterisks, no actions — just the words you'd actually say out loud at the table. Stay in character.`,
    },
    {
      role: 'user',
      content: `What just happened: ${eventDescription}${ctx}\n\nReact in character (one line). Use the table info above only if it naturally informs your reaction — never recite it.`,
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
 * @param {Object} event  { kind, description, actorIds?, prob?, speakerHint? }
 *   kind: short label for the trigger (raise, allin, showdown, win, etc.)
 *   description: what to feed the model (one sentence of what happened)
 *   actorIds: optional playerIds to exclude from speaker pool
 *   prob: optional 0..1 override for this event's roll probability
 *         (defaults to LLM_BANTER_PROB). E.g. human chat replies use
 *         a much lower rate so bots only chime in occasionally.
 *   speakerHint: optional playerId to FORCE as the speaker (overrides
 *         random pick from the pool). Used for "you lost the hand,
 *         react to it" events where we want the loser's voice
 *         specifically, not a random tablemate's commentary.
 */
function maybeSpeak(table, event) {
  const prob = (typeof event.prob === 'number') ? event.prob : PROB;
  if (!shouldSpeak(table.id, prob)) return;
  const speaker = pickSpeaker(table, event.actorIds, event.speakerHint);
  if (!speaker) return;
  // Optimistically claim the cooldown slot — if the call fails the
  // cooldown still elapses naturally, and we avoid a thundering herd
  // of parallel calls if multiple events fire in quick succession.
  _lastSpokenAt.set(table.id, Date.now());
  const messages = buildMessages(speaker, event.description, table);
  callLLM(messages).then(async line => {
    if (!line) return;
    const nick = speaker.player?.nickname || speaker.playerId;
    // 11labs synthesis: only if the speaker has a voice configured and
    // the elevenlabs util is enabled (key present). Failure is silent
    // and we still broadcast the text — clients fall back to chat-only.
    let audio = null;
    if (elevenlabs.ENABLED) {
      const voiceId = voiceFor(nick);
      if (voiceId) {
        try { audio = await elevenlabs.synthesize(line, voiceId); }
        catch (_) { audio = null; }
      }
    }
    const extras = audio ? { audio, audioMime: 'audio/mpeg' } : null;
    table.chat('banter', `💬 ${nick}: ${line}`, extras);
  }).catch(() => { /* silent */ });
}

module.exports = { maybeSpeak };
