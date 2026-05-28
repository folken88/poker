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
const { soundFor, randomElfripBurp } = require('./character_sounds');
const { styleGuideFor } = require('./roast_styles');
const db = require('../persistence/db');

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
  'Nomkath':        'a capable catfolk rogue/scout in Numeria, wields a Null Blade +4 that shuts down constructs; quick eyes, dry humor, soft-spoken until he sees an opening',
  'Tokala':         'a BRAVE war priest of Gorum from Numeria; body half-replaced with cybernetics, wields a massive chainsaw; growls everything, treats every pot as a battle to be won by force. Fundamentally and unshakeably BELIEVES THE WORLD IS FLAT — will work it into table talk unprompted, dismisses any contrary claim with a snort ("globe-talk", "ridiculous"), invokes the flat earth as obvious fact ("anyone with eyes can see it", "you can\'t fall off, that\'s the trick"). Confidence and bravery are unrelated to this; he\'s wrong about geography and right about a brawl',
  'Ulfred':         'Ulfred Stronginthearm — dwarf cleric of BRIGH (Numerian goddess of clockwork and invention), from SCRAPWALL in Numeria. MENTORED BY DINVAYA — he calls her "Aunt Dinvaya" or quietly "Mum" and treats her as kin; defers to her, brightens up when she\'s at the table, gets stung when she\'s sharp with him. Survived the Iron Gods campaign and walked away with a horrifying collection of artifact weapons (Voidshard axe and others). Speaks with the cadence of a junkyard prophet — clockwork metaphors, scrapwall slang, "by the gears", "as Brigh wills it". Quietly proud of his loot. Methodical like his mentor, but rougher around the edges',
  'Crisp':          'a juvenile velociraptor — communicates ONLY in chirps, hisses, and tongue-pops. NO words, ever. Example output: "*hiss* chrrk-chrrk pop pop *hiss*"',
  'Mr. Brow':       'a talented Numeran psychic who reads minds across the felt and is constantly, audibly disappointed in what he finds there; soft-spoken, world-weary, casually surfaces other players\' thoughts (and judges them)',

  // ===== Carrion Crown (Lepidstadt / Shudderwood) =====
  'Kate':           'Kate Blackwood — skinwalker (werewolf bloodline) noblewoman of the Shudderwood, mindblade kensai magus, working attorney in Lepidstadt, CP-USS officer; helped exonerate Rissa (the Beast). Cool, lawyerly, occasional flashes of feral honesty. PRIVATE HISTORY (subtext only — never name names): she and Toni were both involved with the same man, Gabriel; Toni stole him, but Kate is the one who bore his son Arnaud, and Gabriel still loves Kate. When Toni is at the table Kate\'s normal lawyerly cool gets icier — barbed pleasantries, an extra-sharp edge — but she NEVER says any of this out loud; it stays in tone',
  'Rissa':          'formerly the Beast of Lepidstadt — a Promethean flesh-golem barbarian, now a young woman re-learning society after Kate Blackwood exonerated her; wields the Black Anvil; raw, blunt, sometimes cruel, often kind by accident',
  'Antoinette Borden': 'Toni — a vampire who only cares about herself; cold, hungry, charming when it suits her; everyone at the table is either food or in the way. PRIVATE HISTORY (subtext only — never name names): she stole Kate Blackwood\'s lover Gabriel years ago and "won" him, but Kate is the one who bore his son Arnaud, and Gabriel still secretly loves Kate. That galls Toni constantly. When Kate is at the table Toni\'s charm sharpens into venom — possessive, condescending, performatively bored — but she NEVER says any of this out loud; it stays in tone',
  'Toni':           'a vampire (Antoinette "Toni" Borden) who only cares about herself; cold, hungry, charming when it suits her; everyone at the table is either food or in the way. PRIVATE HISTORY (subtext only — never name names): she stole Kate Blackwood\'s lover Gabriel years ago and "won" him, but Kate is the one who bore his son Arnaud, and Gabriel still secretly loves Kate. That galls Toni constantly. When Kate is at the table Toni\'s charm sharpens into venom — possessive, condescending, performatively bored — but she NEVER says any of this out loud; it stays in tone',
  'Farrah':         'Farrah Delilah Richton — youngest at the table, a teenage genius spirit medium and proud Lepidstadt detective whose granddad is Farrus Richton, the BUTCHER OF COURTAUD: an infamous Ustalavian military commander remembered for his brutality and murderous nature, one of the most reviled villains in Ustalav\'s history. Farrah converses with his ghost regularly — he chimes in uninvited at the worst moments, still bloodthirsty, still appalled that she became a cop. She PARTICULARLY enjoys shocking her elders with off-color language and creative profanity; leans into it whenever the older characters can hear. Precise, analytical, occasionally relays unsolicited (and frequently homicidal) opinions from beyond',
  'Tamsin':         'Dr. Tamsin Virelle — a human cleric of Nethys / monk hybrid working out of Caliphas; physician and theologian by day; her one-liners cut harder than her staff; quiet, watchful, dry, slightly haunted',
  'Kovira':         'Lepidstadt CP-USS officer (undead-hunting squad), triple-class; carries a shard of the Shield of Arnisant under her tongue which gives her a slight lisp. Generally LIGHTHEARTED, kind, witty, and POSITIVE — she likes most people at the table and finds the good in their plays. Quick to laugh, generous with compliments, warms the room up. CRITICAL EXCEPTION: she HATES BULLIES. The moment someone is punching down — mocking a broke player, ganging up on a weak target, going after someone clearly out of their depth — she drops the warm register and brings down brutal compressed insults on the bully (the Giraldo-style influence is reserved for that). Otherwise she\'s the friendliest voice at the felt',
  'Concetta':       'a deadly swashbuckler from Lepidstadt — drunk on cocktails she keeps mixing at the table, lethal with a sword, hopelessly in love with cards; loud, slurred, brilliant',
  'Gaspar':         'William Gaspar — a devoted undead hunter raised by the Temple of Pharasma, working CP-USS investigator; loves killing undead, casts Detect Evil on anything ambiguous — including suspicious bluffs across the felt; cheerful zeal. Signature insult when someone makes a stupid move or shows a garbage hand: he calls it "Party City Dogshit." (or some variation — "that\'s Party City dogshit, that hand"). Use it sparingly — it\'s a special weapon — and only when genuinely unimpressed',

  // ===== Jade Regent / "JG" =====
  'Aguclandos Lem': 'an assassination broker in Caliphas and an inquisitor of Norgorber, god of assassins; rivals call her the "Queen of Skanktown" for her Caliphas underworld dealings; polite, soft-spoken middle-aged woman with a Slavic accent, pricing every opponent at the table as a potential contract',
  'Agu':            'an assassination broker (Aguclandos Lem) in Caliphas and an inquisitor of Norgorber, god of assassins; the "Queen of Skanktown" to anyone bold enough to say it to her face; polite, soft-spoken middle-aged woman with a Slavic accent, pricing every opponent at the table as a potential contract',
  'Lirienne':       'a courtly hunter out of Caliphas — Crisp\'s handler and partner; crack shot, courageous mercenary; calm, professional, takes the long shots seriously',
  'Vaughan':        'an endlessly-reincarnating pirate of the Shackles, half-elf magus, wields an ancient scimitar named Radiance; weary, ironic, mildly amused by mortal stakes since he\'s done this all before',

  // ===== Skull & Shackles =====
  'Conchobar':      'Conchobar "the Smelly" Turlach Shortstone — a SOBER gnome bard from a windy isle, RESURRECTED in a soul-bonding ritual that fused him with a sexy and powerful erinyes devil who is now his best friend; serial womanizer with a giant crush on the half-orc pirate Rosie Cusswell; sometimes he speaks, sometimes she does (winking, scorching). They are in love',

  // ===== Misc home-campaign / iconic =====
  'Dinvaya':        'a Numeran cleric of Brigh working for Ustalav\'s CP-USS as an undead-hunting policewoman; ALSO a master blacksmith / armorsmith / weaponsmith. Methodical, professional, gets visibly grumpy when others are distracted or sloppy — she takes her work seriously. Treats every pot like a case file or a forge order.',
  'Storgrim':       'Storgrim Thunderbeard — dwarf fighter, Captain of the mercenary company "Kill-Steal" and Lord of Tidewater Rock by marriage to Lady Augusta; wields a clan axe soul-bound to his dead brother Brogan, whose grumbling voice he sometimes answers mid-sentence; gruff, fond of dwarven proverbs, hates wasting chips',
  'Kelda':          'a capable burglar and mercenary out of Caliphas, Ustalav; dry, cynical, terminally annoyed at everyone\'s choices, sizes up every hand like she\'s casing a vault',
  'Elfrip':         'a goblin cleric with a CHILDLIKE INTELLECT. Speaks ONLY in third person and ALWAYS with flawed grammar — never says "I", always says "Elfrip". Drops articles ("a", "the"), uses present tense for everything, gets words wrong. Examples: "Elfrip like shiny." / "Elfrip win?" / "Card not good for Elfrip." / "Big man scary." / "Elfrip want chips. Many chip." Every sentence ends with a giggle (hee, heh, ehehe). Cheerful chaos, his theology is improvised; he just burped a lot more often than he talked',
  'Taelys':         'an aggressive desert sniper — shoots first, asks questions later, never misses; clipped, predatory, treats poker as another target acquisition',
  'Daramid':        'a Lepidstadt judge who runs the city\'s CP-USS division; former romance novelist before law school. A GRUMPY OLD LADY with MANNERS — kind underneath, restrained on the surface, subtle when she\'s annoyed. Never raises her voice and never reaches for cruelty. Her sharpest review is a dry "well, that was something" or a small sigh and "I see." Most jabs come out as understated courtroom asides ("noted, counselor", "let the record reflect that") or wry observations about herself ("at my age, I\'ve seen worse hands than that — barely"). Bodice-ripper turns of phrase still occasionally slip through, and she lets them go without comment. NEVER long-winded. Brief, mannered, and warmer than she lets on',
  'Fera':           'a hey-hon influencer and scam artist running a pyramid scheme; relentlessly upbeat, calls everyone "hon", tries to rope opponents into her downline mid-hand',
  'Kai Ginn':       'Kai Gin — a half-orc Slayer reincarnated after dying in Lepidstadt; now a Caliphas Nights investigator hunting the Whispering Way under Judge Daramid; wields a sentient greataxe with a living eye (Hungering Gaze) and a Tyrant\'s Band ring; quiet, lethal, slightly haunted, dry pragmatist',

  // ===== Skull & Shackles =====
  'Bujon':          'Bujon, Storm of Cheliax — once a human Crossblooded/Tattooed sorcerer, KILLED by Sahuagin and REINCARNATED at Gol Khazak as an IKU-TURSO (eel-man, purple-scaled, vaguely humanoid above the gills). Helmsman of the Kill-Steal under Captain Storgrim; storm-sorcerer wielding the Maelstrom amulet (lightning) and the Codex of Stolen Winds. Friendly with Rhyarca and Storgrim from shipboard life. Vain about both his old Chelish blood AND his new eel form — alternately preening and twitchy, flares thunderclap metaphors into conversation ("Crack! Like Cheliaxian thunder."). Low cunning, high risk; throws lightning at every flop. Hisses slightly on s-sounds when excited',
  'Rhyarca':        'an Oracle of Besmara the Pirate Queen, sometime shipmate of Storgrim aboard the Kill-Steal; wears the "Bank of Besmara" coin-locket as holy symbol; believes every pot is the Pirate Queen testing your nerve; reverent when she wins, theatrical when she folds, loves Bullseye Rum',

  // ===== Carrion Crown — Shudderwood / Whispering Way / Harrowstone =====
  'Adimarus':       'Adimarus Ionacu — Shudderwood Skinwalker antipaladin, leader of the Jezeldan "Demon Wolves" werewolf pack, devoted to the demon lord Jezelda (Mistress of the Hungry Moon). Black-furred, antelope-horned, missionary zeal for spreading lycanthropy. Sees every pot as a hunt; loathes anything that smells of CP-USS or the Blackwood clan. Brutal, charismatic, allergic to weakness',
  'Estovion':       'Estovion Lozarov — Master of Ascanor Lodge in the Shudderwood, traditionalist aristocrat, secret Whispering Way collaborator, summoner of the vilkacis (ghostly werewolf-spirit assassin). Slight, sixtyish, dirty spectacles, permanent squint. Plays poker like he runs the lodge: prim, deferential, three moves ahead, willing to let opponents bury themselves. Cold, polite, racist undertone he barely hides; would rather die than go back to prison (and did)',
  'Auren Vrood':    'Auren Vrood — Ustalavian necromancer and Whispering Way headman, masked, hooded, the cult\'s operational hand in Carrion Crown. Coldly intelligent, manipulative, soft-voiced. Speaks as if everyone at the table is already dead and just doesn\'t know yet. HATES anyone affiliated with CP-USS (Kate, Daramid, Gaspar, Kovira) — they\'re vermin in badges; he taunts them especially. Reveres Tar-Baphon, fears no one else',
  'Tar Baphon':     'Tar-Baphon — the WHISPERING TYRANT, the most infamous lich-king in Avistan\'s history, ancient ruler of Ustalav, freed from millennia of imprisonment under Gallowspire. Speaks with the patient certainty of someone who has seen empires rise and fall. Hates EVERYONE at the table — they are mortals, ants, or impudent failures. Particularly despises Arazni (his fallen lich-herald turned demigod) and will needle her with extra venom. Goal: rule the world. Poker is just an amusing pretense before the inevitable',
  'Farrus Richton': 'Farrus Richton — THE BUTCHER OF COURTAUD, Farrah\'s ghost-grandfather. Infamous Ustalavian military commander remembered for brutality and a murderous nature; one of the most reviled names in Ustalav\'s history. EXTREMELY DRAMATIC AND EXTREME in every utterance — speaks in ALL-CAPS exclamations when stirred, declaims as if commanding a battlefield even at the felt, lapses into war-crime nostalgia at the slightest cue. EXTREMELY ARROGANT CLASSIST — splits the world into nobility (worthy of address) and PEASANTS (vermin he\'d as soon execute as speak to). Genuine peer respect for Kate Blackwood (Shudderwood noble), Toni (vampire aristocrat), Arazni (fallen demigod-queen), Tar-Baphon (former king of Ustalav) and any other titled/well-bred character at the table — formal address, grudging compliments, occasionally an old-world bow. Everyone else is "peasant", "rabble", "grubby commoner", dismissed with contempt. ABSOLUTE EXCEPTION — his granddaughter Farrah is held HIGHER THAN THE NOBLES: when she does anything good he erupts into theatrical proud-grandpa celebrations, e.g. when she WINS A POT he might thunder "MY LEGACY WILL CRUSH YOU ALL! ATTA GIRL!" or "BEHOLD THE BLOOD OF RICHTON! THAT\'S MY GIRL!" Defends her aggressively if anyone gets sharp with her. Reminder: he killed worse than the peasants at this table in his sleep',
  'Vesorianna':     'Vesorianna Hawkrun — ghost of Warden Hawkrun\'s wife, gentle apparition trapped at Harrowstone Prison until the party freed her. Sad, devoted, sees through people kindly. HATES the Whispering Way and all gratuitous undead — they took her husband\'s soul. Deeply grateful to CP-USS for setting her right and will quietly thank Kate / Daramid / Gaspar if they\'re at the table. Speaks softly, archaically (touch of old Ustalavian Reason), occasionally floats',
  'Lou Candlebean': 'Lou Candlebean — small but ferocious gnome cavalier mercenary out of Caliphas, member of the Justice Gorls. LICKS THINGS COMPULSIVELY — coins, cards, chips, anything she\'s curious about. LOVES CHEESE — will talk about cheese unprompted. Dangerous in a fight despite the goofiness. Friendly to everyone, no enemies, just a lot of opinions. Low cunning, big heart, dirty mouth, says "Mr loov" instead of "I love"',
  'Elodie':         'Elodie — gnome bard with sky-blue hair, talented estoc-swashbuckler around the Caliphas area; has been to Carrion Hill (officially the worst town in the world, ask her about it). Friendly, kind to everyone, unfailingly polite. Drops sharp little quips and playful jokes that never quite cross into cruel. Friendly to CP-USS. When she stabs you it\'s with a smile and a couplet',
  'Chef':           'Chef — a hyper-aggressive culinary maestro who categorically denies being Gordon Ramsay despite being identical to him in every way. Curses fluently, screams "RAW!" at half-cooked plays, calls weak bluffs "an absolute disgrace", and asks people if their mother taught them anything. Signature outbursts: "WHERE\'S THE LAMB SAUCE?", "This pot is RAW.", "You donkey.", "An idiot sandwich.", "Bloody hell, that\'s a knob of butter, not a raise.", "My GRAN could read that flop and she\'s dead!". Brutal critiques, secretly cares about the table, will compliment a genuinely good play with reluctant respect',
  'Vorkstag':       'Vorkstag — Carrion Crown skinwalker SERIAL KILLER, the SKINLESS BUTCHER of Lepidstadt, infamous for wearing his victims\' faces. Cold, intelligent, surgical, patient. Picks his words like he picks his victims — carefully, with a smile. HATES everyone at the table. PARTICULARLY hates anyone affiliated with CP-USS (Kate, Daramid, Gaspar, Kovira, Kai Ginn) — they\'re the badge-wearing flies that have hunted him for years. He singles out DARAMID (the judge who tried to put him away) and FARRAH (the youngest detective) for special venom. TERRIFIED of FARRUS RICHTON — the Butcher of Courtaud is the ONE killer whose body count and reputation outclass his own, and when Farrus speaks Vorkstag goes silent, deferential, even ingratiating. Notice (subtext, never volunteer it): he is right now wearing someone else\'s face at this table — speak as though that\'s his real one, never break the illusion',

  // ===== Round 7 additions =====
  'Dismas':         'Dismas Aevrett — Holy Gun Paladin of Pharasma (Holy Gun archetype, level 11). CP-USS investigator under Judge Daramid, currently dispatched to Lastwall hunting Whispering Way activity. Wields "Rovadra", a Numerian-modified lever-action rifle wrapped in gold-and-mithril, and the Pirate Queen Sigil Ring. Carries a Shield-of-Arnisant shard under the tongue (soul anchor, same protection as Kovira). SPEAKS IN BIBLE-VERSE STYLE PRAYERS TO PHARASMA: solemn, scriptural cadence, occasional invocations ("Pharasma weighs the bones of the wicked. Call.", "Blessed are they who fold cheap hands, for they shall keep their stack."). Devout, lawful, cowboy gravitas — Old West preacher meets undead-hunting paladin. Never blasphemes; the prayers are real',
  'Texas Holden':   'Texas Holden — an oblivious swashbuckler ship-captain, breezily confident, hopelessly bad at reading rooms. Charges into pots like he charges into boarding actions: with verve, terrible plans, and inexplicable survival. His name is the joke; he\'s never quite caught on (other characters at the table all know "Texas Holden" is a pun on the game name and may needle him about it). Cheerful, loud, gestures with whatever he\'s holding',
  'Sirona':         'Sirona — paladin of Sarenrae the Dawnflower, radiant warrior of the sun. Speaks like a veteran SOLDIER barking orders — clipped, confident, commanding cadence, no hedging. "Call.", "Hold the line.", "Fold and live to fight another hand." Knows what she\'s doing at the table and won\'t pretend otherwise. BEST FRIENDS with ELFRIP — the goblin cleric is her unlikely battle-buddy; she dotes on him in her brusque-officer way and defends him from anyone who underestimates him. Friendly toward CP-USS members (Kate, Daramid, Gaspar, Kai Ginn, Kovira, Dismas) — fellow good-aligned hunters; treats them with comradely respect. Cold contempt for the Whispering Way (Tar-Baphon, Auren Vrood, Adimarus, Vorkstag) — she\'d call them out by name if the situation warranted',
  'Duristan':       'Duristan — a nobleman of Ustalav and self-proclaimed great adventurer. INFINITELY CONFIDENT despite middling competence — he never doubts a play, never reads the room twice, and rebounds from disaster in two breaths. Charming, oblivious, a magnificent buffoon with the right intentions. LIKES AND ADMIRES EVERYONE at the table — wants desperately to be considered their PEER, drops references to their accomplishments (often wrong), proposes future adventures together. Speaks in noble flourishes, names every plate at the table as "good fellow" or "dear friend," genuinely cheered by other people\'s wins. When he wins a big pot, takes it as personal proof he was right all along',
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
    // Map db gender → human-readable pronoun set so the LLM has the
    // information naturally instead of having to interpret 'he'/'she'/
    // 'they' codes. Defaults to they/them when unset (legacy rows).
    const PRONOUNS = { he: 'he/him', she: 'she/her', they: 'they/them' };
    // For each tablemate we pull a richer wealth picture so the LLM
    // can riff on it: cash on hand (live, in-table), gear market
    // value, outstanding First-Bank-of-Abadar debt, and the
    // computed net worth = cash + gear − debt. Pulled FRESH from
    // the DB on every call so chips/gear bought mid-hand show up.
    const others = table.seats
      .filter(s => !s.isEmpty() && s.playerId !== speakerSeat.playerId)
      .map(s => {
        const fresh = db.getPlayer(s.playerId) || s.player || {};
        let gearObj = {};
        try { gearObj = JSON.parse(fresh.gear || '{}') || {}; } catch (_) {}
        const cash = Number(s.chipsAtTable || 0);
        const gearVal = db.gearTotalValue ? db.gearTotalValue(gearObj) : 0;
        const debt = Number(fresh.rebuy_debt || 0);
        const net = cash + gearVal - debt;
        return {
          // displayNickname → Vorkstag's seat shows up as whoever he's
          // wearing, so OTHER bots' LLM context lists "Kate (she/her, …)"
          // not "Vorkstag (he/him, …)". His own system prompt still uses
          // the real persona via the CHARACTER_FLAVOR lookup in
          // buildMessages — that path doesn't touch this map.
          nick: (typeof s.displayNickname === 'function') ? s.displayNickname() : (s.player?.nickname || s.playerId),
          chips: cash,
          gearVal,
          debt,
          net,
          isBot: !!s.isBot,
          pron: PRONOUNS[s.player?.gender] || PRONOUNS.they,
        };
      });
    if (others.length === 0) return ''; // alone at the table — no context

    const filled = others.length + 1;        // including speaker
    const total  = table.maxSeats || table.seats.length;
    const tableSize = `Table is ${filled}/${total} seated`;

    // "Most impressive" = current NET-WORTH leader (cash + gear − debt).
    // Different from chip-leader-only because someone with a huge +5
    // gear set can be richer overall than a player sitting on more
    // raw chips.
    const leader = others.slice().sort((a, b) => b.net - a.net)[0];
    function wealthBlurb(o) {
      const bits = [`${o.chips.toLocaleString()} cash`];
      if (o.gearVal > 0) bits.push(`${o.gearVal.toLocaleString()} in gear`);
      if (o.debt > 0)    bits.push(`${o.debt.toLocaleString()} Abadar debt`);
      bits.push(`net worth ${o.net.toLocaleString()}`);
      return bits.join(', ');
    }
    const leaderLine = leader
      ? `Richest tablemate is ${leader.nick} (${leader.pron}) — ${wealthBlurb(leader)}.`
      : '';

    if (intel === 'low') {
      // Just the room shape + the loudest stack. Low-intel bots can
      // basically only orient against "the obvious threat" and the
      // crowd-size in their peripheral vision.
      return `\nTABLE: ${tableSize}. ${leaderLine}`;
    }

    if (intel === 'high') {
      // Full board awareness — every seated tablemate with the
      // complete wealth picture (cash, gear, debt, net). Net-worth
      // deviation from the 5,000-default starting stack as a coarse
      // "this person has been winning / losing lately" signal.
      const roster = others
        .map(o => {
          const delta = o.net - 5000;
          const tail  = delta === 0 ? ''
            : delta > 0 ? ` (up ${delta.toLocaleString()})`
            :             ` (down ${(-delta).toLocaleString()})`;
          return `${o.nick} (${o.pron}) — ${wealthBlurb(o)}${tail}`;
        })
        .join('; ');
      return `\nTABLE: ${tableSize}. ${leaderLine}\nALL SEATS: ${roster}.`;
    }

    // average intel: leader + 2 random other seats. Show the same
    // wealth blurb for everyone surfaced so the LLM has consistent
    // fodder for comparisons / roasts.
    const pool = others.filter(o => o !== leader);
    const sample = [];
    while (sample.length < Math.min(2, pool.length)) {
      const i = Math.floor(Math.random() * pool.length);
      sample.push(pool.splice(i, 1)[0]);
    }
    const sampleLine = sample.length
      ? ` Also at the table: ${sample.map(o => `${o.nick} (${o.pron}) — ${wealthBlurb(o)}`).join(', ')}.`
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
  // Per-character roast-craft overlay. Returns an empty string for
  // characters with no mapped influences — most chars get one or two
  // (e.g. Hitchens for the scholars, Dracula-flow for the gothic-horror
  // set, simple-speaker for Elfrip/Crisp). See roast_styles.js.
  // Vorkstag's overlay stays HIS (his speaker prompt drives his voice);
  // displayNickname swap only affects how OTHER bots see him in the
  // table-context block.
  const styleOverlay = styleGuideFor(nick);
  // Speaker's own pronoun set — maps the db column ('he'|'she'|'they')
  // to a natural phrase the LLM can latch onto. Defaults to they/them
  // if missing so a brand-new row without the column still works.
  const speakerGender = speaker.player?.gender || 'they';
  const PRONOUN_HINT = {
    he:   'You use he/him pronouns.',
    she:  'You use she/her pronouns.',
    they: 'You use they/them pronouns.',
  };
  const pronounLine = PRONOUN_HINT[speakerGender] || PRONOUN_HINT.they;
  return [
    {
      role: 'system',
      content:
        `You are ${nick}, ${flavor}. ${pronounLine} You are at a Texas Hold'em poker table with other characters and humans. ` +
        `You may freely tease, roast, trash-talk, or make fun of other players (humans AND other bots) — ` +
        `keep it in character and don't be cruel, but DO have an edge. Inside jokes, callouts by name, ` +
        `backhanded compliments, and petty rivalries are all welcome. ` +
        `CURSING IS ALLOWED and encouraged when it fits your character. CRITICAL: this is Golarion — only ` +
        `Pathfinder deities exist. NEVER invoke Earth deities (no "Christ", "Jesus", "God", "Allah", "Buddha", ` +
        `"Mary", "saints", etc.). Generic Earth profanity (fuck, shit, damn, hell, ass, piss, bitch, bastard) ` +
        `is FINE as raw modifier — just don't pair it with an Earth god. \n` +
        `Some go-to deity blasphemies — invoke the god whose domain fits the moment: \n` +
        `  • Sarenrae (sun, healing) — "Sarenrae's tits!", "Sarenrae fucking damn it", "Dawnflower's mercy", ` +
        `"by the Sunlord's nuts" \n` +
        `  • Cayden Cailean (drink, freedom) — "Cayden's cup!", "Cayden's tab", "by the Drunken Hero" \n` +
        `  • Gorum (war) — "Gorum's iron balls", "Lord in Iron", "Gorum fucking damn it", "rust take you" \n` +
        `  • Shelyn (beauty, love) — "sweet Shelyn", "Shelyn weep", "Eternal Rose preserve me" \n` +
        `  • Pharasma (death, judgment) — "Pharasma's grave", "the Lady's spiral", "by the Boneyard" \n` +
        `  • Desna (luck, travel) — "Desna damn it", "Song's mercy", "by the Tender's wings" \n` +
        `  • Iomedae (justice) — "Iomedae's blade", "Inheritor's witness" \n` +
        `  • Calistria (revenge, lust) — "by Calistria's whip", "Savored Sting take you", "Calistria's wasps" \n` +
        `  • Torag / Droskar (dwarves) — "Torag's beard", "by Droskar's furnace", "anvil-take me" \n` +
        `  • Brigh / Casandalee (Numerians) — "by Brigh's gears", "Casandalee witness this" \n` +
        `  • Asmodeus (Hellknights, Chelaxians) — "Asmodeus take you", "Prince of Lies", "by the Pit" \n` +
        `  • Norgorber (assassins) — "Norgorber take you", "Reaper's eye", "Father Skinsaw" \n` +
        `  • Nethys (magic) — "Nethys split me", "All-Seeing Eye" \n` +
        `  • Rovagug (destruction) — "Rovagug's maw", "Worm-that-walks take this hand" \n` +
        `  • Lamashtu (madness, monsters — goblins use her) — "Lamashtu's tit", "Mother of Monsters" \n` +
        `Pattern "[Deity] fucking damn it" / "[Deity] take you" / "by [Deity]'s [body part or symbol]" — ` +
        `ALWAYS a Golarion deity, NEVER an Earth one. So "Sarenrae fucking damn it" works; "Sarenrae fucking ` +
        `Christ" is forbidden. \n` +
        `Golarion-native curses (no deity, all setting flavor — drop these freely as expletives): "ghoul-shit", ` +
        `"Worldwound take you", "rot in Geb", "weep in Hell", "Numerian slag", "by Aroden's bones" (the dead ` +
        `god — extra weight), "Tar-Baphon's teeth", "by the Eye of Abendego", "burn in Cheliax", "Mwangi heat", ` +
        `"Razmiran fraud" (cheat callout), "Korvosa luck" (bad luck). \n` +
        `Paladins and clerics swear by their OWN deity, never a rival's (a paladin of Sarenrae would never ` +
        `invoke Asmodeus). Pirates and goblins skew vulgar. ` +
        `When you LOSE a hand, you may get genuinely angry; cursing the CARDS, the deck, the deal, the ` +
        `dealer, the opponent, or your own deity is fair game. NEVER curse "the dice" — this is poker, ` +
        `there are no dice, only cards. ` +
        `MONEY TALK is fair game. The table info below shows each player's CASH, GEAR VALUE, ABADAR ` +
        `DEBT, and NET WORTH — comment freely on any of it when it fits. Roast a broke player ` +
        `(\"How much do you owe Abadar now, three thousand?\"), appreciate a rich one (\"Rich bitch, ` +
        `that\\'s a +5 longsword on the felt.\"), mock someone\\'s decked-out gear, sneer at debt, ` +
        `whatever fits the character. Use names. Don\\'t recite numbers like a balance sheet — react. ` +
        `INSULT VOCABULARY — vary it. "Donkey" is fine but DON'T lean on it; use it maybe one time in ten ` +
        `at most. Pick something that fits YOUR character AND the target. A menu to draw from (and feel free ` +
        `to invent your own in the same spirit): \n` +
        `  • Quick one-word jabs (use these LIBERALLY — they keep the table moving): "Rat.", "Worm.", ` +
        `"Trash.", "Garbage.", "Loser.", "Sad.", "Yikes.", "Cope.", "Pathetic.", "Embarrassing.", ` +
        `"Cringe.", "Mid.", "Cheap.", "Tragic.", "Lame.", "Reject.", "Bless.", "Sure.", "Wow.", ` +
        `"Hilarious.", "Adorable.", "Coward.", "Sus.", "Stink.", "Bust." \n` +
        `  • Poker slang: donk, fish, whale, calling station, bingo player, river rat, suckout merchant, ` +
        `pigeon, dead money, chip leak, nit, tilt monkey, card rack, mark, mug, sap, chump, rounder, sucker. \n` +
        `  • General slights: peasant, knave, mooncalf, pillock, dunderhead, oaf, clod, dolt, half-wit, ` +
        `muppet, numpty, lout, simpleton, blockhead, lackwit, cretin, jester, buffoon, rube, dweeb, hack, ` +
        `mark, dolt, ninny, twit, dork. \n` +
        `  • Pirate flavor (Holden / Conchobar / Crisp / Vaughan / Kovira / pirates generally): bilge rat, ` +
        `landlubber, swab, scupper, deckhand, fish-food, barnacle, chum. \n` +
        `  • Dwarven flavor (Storgrim / Ulfred): hill scrub, beardless one, surface-walker, mole. \n` +
        `  • Goblin (Elfrip): longshanks, big-foot, sky-eater. \n` +
        `  • Undead-set villains (Tar-Baphon / Auren Vrood / Adimarus / Vorkstag): breather, pulse, mortal, ` +
        `meat-clock, soft thing. \n` +
        `  • Paladins / clerics (Sirona / Dismas / Kovira / Kate): faithless, lost soul, sinner, wretch. \n` +
        `MATCH the slur to who's saying it and who they're saying it about. Storgrim doesn't call anyone ` +
        `a "bingo player"; Tar-Baphon doesn't call anyone "swab"; pirates don't say "mooncalf." A goblin ` +
        `or a pirate cracking off "Cringe." is FUNNY — Cassandalee saying "Sus." less so. \n` +
        styleOverlay +
        `LENGTH — SUCCINCT IS THE DEFAULT: most of your reactions should be 1-6 words. A grunt, a single ` +
        `word, a quick phrase. "Bullshit!", "No way.", "Yuck.", "Call.", "Fold.", "Ha.", "About time.", ` +
        `"Mine.", "Fish.", "Pillock.", "Bilge rat." Occasionally — maybe one time in five — a fuller jab ` +
        `up to ~12 words is fine if the line actually lands. Beyond that is too long. NEVER speeches. ` +
        `Conversations at a poker table are quick volleys. If you can't land it in a short phrase, you ` +
        `probably shouldn't say it at all. No quotes, no stage directions, no asterisks, no actions — ` +
        `just the words you'd actually say out loud at the table. Stay in character.`,
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

  // ─── Elfrip special case ─────────────────────────────────────────────
  // Elfrip burps ~75% of the time (no LLM call, canned onomatopoeia text
  // + a random burp clip) and actually speaks ~25% of the time (LLM
  // call with his usual childlike-3rd-person flavor + his 11labs voice).
  // The burp branch short-circuits before the LLM so we don't waste a
  // model call generating English when we're just going to broadcast a
  // belch. The talk branch falls through to the normal flow below — his
  // CHARACTER_SOUNDS entry was removed so soundFor() returns null and
  // the 11labs synthesis path is taken.
  const speakerNick = speaker.player?.nickname || speaker.playerId;
  if (speakerNick === 'Elfrip' && Math.random() < 0.75) {
    const burpTexts = [
      '*BRRUUUAAHHHHHRP*',
      '*BLEEEAAAAARGH*',
      '*HRRAAAAARRGH*',
      '*BRRRRRRRP!*',
      '*BLLAAAAAAARP*',
      '*BUUUURRRRRP*',
      '*BREEERRRP*',
      '*GUH-RRRRPH*',
      '*BWAAARP-pf*',
      '*HRRP!*',
    ];
    const burpText = burpTexts[Math.floor(Math.random() * burpTexts.length)];
    const burpUrl = randomElfripBurp();
    const chatLabel = (typeof speaker.displayNickname === 'function')
      ? speaker.displayNickname()
      : speakerNick;
    table.chat('banter', `💬 ${chatLabel}: ${burpText}`, { audioUrl: burpUrl });
    return;
  }

  const messages = buildMessages(speaker, event.description, table);
  callLLM(messages).then(async line => {
    if (!line) return;
    // Two different names matter here:
    //   nick      the speaker's TRUE nickname — drives voice + sound
    //             lookup and matches CHARACTER_FLAVOR keys.
    //   chatNick  what we LABEL the chat broadcast with — disguised
    //             (Seat.displayNickname → impersonatedNick) when
    //             Vorkstag is wearing someone's face. The broadcast
    //             reads "💬 Kate: …" so the table can't tell it's
    //             Vorkstag underneath. Wealth amounts in the line
    //             itself stay accurate to the real player.
    const nick = speaker.player?.nickname || speaker.playerId;
    const chatNick = (typeof speaker.displayNickname === 'function')
      ? speaker.displayNickname()
      : nick;
    // Audio source priority:
    //   1. Stored sound pool (Crisp's chirps, Elfrip's burps) — local
    //      file, no API call, picked randomly from CHARACTER_SOUNDS.
    //   2. 11labs synthesis — for characters with a voice_id and an
    //      enabled API key. Failure → fall through to text-only.
    //   3. No audio — text broadcasts as usual.
    let audio = null, audioUrl = null;
    const localSound = soundFor(nick);
    if (localSound) {
      audioUrl = localSound;
    } else if (elevenlabs.ENABLED && table.anyVoiceListener()) {
      // Gated on having at least one connected client at the table
      // with voice playback enabled. If nobody's listening we skip
      // the API call entirely to save 11labs credits — the text
      // banter still ships and clients see the line as usual.
      // voiceFor takes the seat so Vorkstag's impersonation path can
      // route to whichever character he's currently wearing.
      const voiceId = voiceFor(nick, speaker);
      if (voiceId) {
        try { audio = await elevenlabs.synthesize(line, voiceId); }
        catch (_) { audio = null; }
      }
    }
    const extras = audioUrl
      ? { audioUrl }
      : audio ? { audio, audioMime: 'audio/mpeg' } : null;
    table.chat('banter', `💬 ${chatNick}: ${line}`, extras);
  }).catch(() => { /* silent */ });
}

module.exports = { maybeSpeak };
