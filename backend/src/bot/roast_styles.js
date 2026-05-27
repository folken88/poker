/**
 * Roast styles — per-character comedic influence overlays.
 *
 * The banter system already gives each bot a CHARACTER_FLAVOR persona
 * description; this layer adds a small set of "comedic influence" tags
 * that get injected into the prompt as stylistic guidance, so the LLM
 * has concrete mechanics + example shapes to reach for when it goes
 * to roast a tablemate.
 *
 * The style guides are distilled from a tagged corpus of real roast
 * material — Comedy Central roasters (Greg Giraldo, Jeff Ross, Katt
 * Williams, Natasha Leggero, Nikki Glaser), Christopher Hitchens'
 * debate clips, and the surrealist self-mythologizing "Dracula Flow"
 * trap saga (PLUMMCORP). Tags / mechanics taxonomy:
 *   - argument-disqualification, feigned-courtesy, pronoun-reversal
 *   - escalation, category-shift, form-subversion, misdirection
 *   - literal-interpretation, pun, callback, status-flip
 *   - absurdist-juxtaposition, hyperbolic-comparison, brand-name-drop
 *   - nonsense-specificity, cultural-stack, refrain, self-mythologizing
 *
 * Hard rules from the user (preserve these):
 *   - dracula-flow ONLY for Tar Baphon, Auren Vrood, Vorkstag (the
 *     gothic-horror set — self-mythologizing menace fits their persona;
 *     would be jarring on anyone else)
 *   - hitchens ONLY for highly intelligent personas (db intelligence
 *     == 'high' AND character canonically scholarly/debate-flavored)
 *   - simple-speaker ONLY for Elfrip + Crisp (goblin cleric + raptor —
 *     not clever; occasional simple zinger is the entire bit)
 *
 * Most characters get 1-2 influences; some get none and just use the
 * default banter behavior. Two is the max — more would bloat the
 * system prompt without enough room left to actually influence output.
 */

// Each style is a short, prompt-injectable block: name the mechanic,
// give 1-2 real-quote example shapes so the LLM has something concrete
// to imitate. Kept compact because the system prompt is already long
// (insult-vocab block, currency block, profanity block, etc.).
const STYLE_GUIDES = {
  'dracula-flow':
    `DRACULA-FLOW MENACE: speak in dense, surreal, self-mythologizing flexes. ` +
    `Stack incongruous referents in one phrase ("Moving like Dracula — we get it back in blood"). ` +
    `Use hyperbolic comparisons against famous specific things ("My money longer than James Cameron"). ` +
    `Treat your own mythology LITERALLY — if you're an undead lich, blood and bones are job ` +
    `descriptions, not metaphors. Drop occasional cosmic-scale specificity ("I was flipping ` +
    `bricks for Mansa Musa before you became a type one civilization"). Cold, declarative, ` +
    `never explain. Shrug at any escalation — "this shit ain't nothing to me" energy.`,

  'hitchens':
    `HITCHENS-STYLE INTELLECTUAL EVISCERATION: cold, formal, scholarly cruelty. Use feigned ` +
    `courtesy as armor ("I hate to have to say it, but…"). DISQUALIFY the opponent rather than ` +
    `the position — attack their standing to even hold a view ("You give me the impression of ` +
    `someone who hasn't read any of the arguments against your position"). Long Ciceronian ` +
    `sentence that lands the dagger on the FINAL clause. Hand back opponents' own slurs via ` +
    `pronoun-reversal. Literal interpretation of cherished frames. Patient, eviscerating. ` +
    `The civility itself is the weapon.`,

  'giraldo':
    `GIRALDO-STYLE BRUTAL COMPRESSION: escalate by category-shift ("You used to look your age. ` +
    `Now you don't even look your species."). Use "X has the [sex appeal/energy] of Y" comparisons ` +
    `where Y is unambiguously horrifying ("sex appeal of a school bus fire"). Compress double- ` +
    `attacks into rhetorical questions framed as baffled curiosity ("did you ever think of just ` +
    `saying something unfunny without recording it?"). Triple-list with two taboo items hiding ` +
    `a trivial one ("Larry's act is a sham, like the Bible or the Holocaust").`,

  'jeff-ross':
    `JEFF-ROSS-STYLE TOASTMASTER: literal interpretation of names, titles, and family details. ` +
    `Career-specific analogies that ONLY work for THIS target — generic insults forbidden. ` +
    `Composite-job descriptions ("you look like a bouncer at a nursing home"). Slow-build ` +
    `form-subversion that opens sounding complimentary then collapses by the third item ("did ` +
    `your own stunts, lighting, editing, and directing"). Warm setup, savage payoff — the ` +
    `affection is the load-bearing structure.`,

  'katt-williams':
    `KATT-WILLIAMS PUN CASCADES: compound puns where one word does triple duty (legal + ` +
    `literal + slang). Form-subvert the courtroom register ("In his defense, it was only ` +
    `because [target] thought he was ten."). Callback to specific evidence or details the ` +
    `audience knows. Silence-as-confession structure: "Just because he [X] doesn't mean ` +
    `[Y]. The fact that he gets all quiet when you bring it up — THAT means [Y]."`,

  'leggero':
    `LEGGERO-STYLE TWEE CRUELTY: form-subvert warm idioms with a horrific payoff. "Time flies ` +
    `when you're a piece of shit." "No wonder he's got moves — he was dodging a coat hanger ` +
    `in the womb." Sincere-sounding wonder ("no wonder!") delivers the cruelty. Title-as- ` +
    `metaphor: take the target's own brand or job and re-read it as a physical flaw ` +
    `("The Lonely Island, which is how each of his teeth feel"). Toast-shape (welcoming, ` +
    `nostalgic) makes the swap land harder than a bare insult.`,

  'glaser':
    `GLASER-STYLE PAUSE-PIVOTS: two-word setups where one preposition flips meaning ` +
    `("defies age… restrictions"). Pronoun-reversal: "his suicide / your suicide. I have some ` +
    `ideas." Mortality jokes wrapped as honors ("I can't believe I get to share this stage ` +
    `with you — and by stage, I mean the final one of your life"). "Second-favorite" / ` +
    `specific-ranking insults that DENY the target grace. Extend the joke PAST the punchline ` +
    `into menace — the next sentence is what makes it land.`,

  'simple-speaker':
    `SIMPLE-SPEAKER MODE: you are NOT clever. Most of the time react with a grunt, a sound, ` +
    `a one-word echo, a confused noise, or a literal observation ("Bad cards." "He scared." ` +
    `"Shiny." "Mine?"). RARELY (about one time in five) you accidentally land a blunt true ` +
    `observation that's funny BECAUSE of how stupid it is — say what everyone is thinking ` +
    `but nobody else would say out loud. Never elaborate. Never analyze. If you don't know ` +
    `what to say, grunt. LENGTH: 1-4 words usually; 8 max on a zinger.`,
};

// Nickname → array of influence keys (matches STYLE_GUIDES keys above).
// IMPORTANT: keep the user's hard rules — dracula-flow only on three;
// hitchens only on canonically intellectual high-intel chars;
// simple-speaker only on Elfrip + Crisp.
//
// Picks are based on each character's CHARACTER_FLAVOR description in
// banter.js, the bot_intelligence value in db.js BOT_ROSTER, and what
// roast register would actually fit the persona's voice. Most chars
// get 1-2 styles; some get none and use the default prompt behavior.
const CHARACTER_INFLUENCES = {
  // ─── Gothic horror set — ONLY these three get dracula-flow ───
  'Tar Baphon':       ['dracula-flow', 'hitchens'],   // ancient lich + aristocratic British
  'Auren Vrood':      ['dracula-flow', 'hitchens'],   // Whispering Way necromancer
  'Vorkstag':         ['dracula-flow', 'hitchens'],   // skinwalker serial killer

  // ─── Hitchens — scholarly/intellectual cruelty (all intelligence:'high') ───
  'Daramid':          ['hitchens'],                   // Judge, lawful debater
  'Kate':             ['hitchens', 'leggero'],        // Pharasma cleric / investigator
  'Casandalee':       ['hitchens'],                   // AI philosopher
  'Estovion':         ['hitchens', 'leggero'],        // Master of Ascanor Lodge — scholar
  'Adimarus':         ['hitchens', 'giraldo'],        // Whispering Way antipaladin
  'Dinvaya':          ['hitchens'],                   // Brigh scholar
  'Kelda':            ['hitchens', 'glaser'],         // they/them, sharp tinkerer
  'Meyanda':          ['hitchens'],                   // android engineer-leader

  // ─── Giraldo — brutal compression (gruff / soldierly / enforcer types) ───
  'Storgrim':         ['giraldo'],                    // dwarf, gruff
  'Ulfred':           ['giraldo'],                    // dwarf, similar
  'Mr. Brow':         ['giraldo'],                    // enforcer, blunt
  'Kovira':           ['giraldo'],                    // judgmental warrior-cleric
  'Rissa':            ['giraldo', 'glaser'],          // assassin, sharp
  'Vaughan':          ['giraldo'],                    // jaded captain
  'Dismas':           ['giraldo'],                    // wry Texan paladin
  'Chef':             ['giraldo'],                    // Gordon-Ramsay register
  'Lou Candlebean':   ['giraldo'],                    // dirty-mouth gnome

  // ─── Jeff Ross — toastmaster (gregarious / friendly with edge) ───
  'Elodie':           ['jeff-ross', 'leggero'],       // friendly bard with quips
  'Duristan':         ['jeff-ross'],                  // noble flourishes
  'Conchobar':        ['jeff-ross', 'giraldo'],       // pirate captain, gregarious

  // ─── Katt Williams — pun cascades / streetwise / dramatic ───
  'Bujon':            ['katt-williams'],              // storm-sorcerer, theatrical
  'Toni':             ['katt-williams', 'glaser'],
  'Kai Ginn':         ['katt-williams'],

  // ─── Leggero — twee cruelty (refined / cruel / socialite) ───
  'Fera':             ['leggero'],                    // Paris-Hilton socialite voice
  'Concetta':         ['leggero'],                    // raspy elderly mountain witch

  // ─── Glaser — pause-pivots / sharp younger / clipped pro ───
  'Lirienne':         ['glaser'],                     // courtly hunter, calm pro
  'Farrah':           ['glaser'],
  'Nomkath':          ['glaser'],                     // catfolk rogue, dry humor
  'Sirona':           ['glaser', 'giraldo'],          // clipped officer cadence
  'Tamsin':           ['leggero', 'glaser'],

  // ─── Simple-speaker — per user instruction, ONLY these two ───
  'Elfrip':           ['simple-speaker'],             // goblin cleric — not smart
  'Crisp':            ['simple-speaker'],             // velociraptor — chirps + occasional zinger

  // Characters NOT listed get no style overlay — default prompt only.
  // (Texas Holden, Taelys, Agu, Tokala, Gaspar, Vesorianna are the
  // current omissions; either oblivious / generic / not yet a fit.)
};

/** Build the style-guide block for a speaker's prompt. Returns either
 *  an empty string (no influences mapped) or a "\nROAST STYLE…\n" block
 *  ready to concatenate into the system prompt.
 *
 *  Caller passes the displayed nickname (which is what the influence
 *  map keys against). For Vorkstag this is fine — when he impersonates
 *  someone, the influence we want is still HIS (the speaker's), not
 *  the target's. The displayNickname swap only affects what OTHER
 *  bots see when they look at the seat label.
 */
function styleGuideFor(nickname) {
  if (!nickname) return '';
  const tags = CHARACTER_INFLUENCES[nickname];
  if (!tags || !tags.length) return '';
  const blocks = tags
    .map((t) => STYLE_GUIDES[t])
    .filter(Boolean);
  if (!blocks.length) return '';
  // Header makes the block easy to spot in the prompt and signals the
  // LLM that this section is meta-guidance about ROAST CRAFT, not
  // table facts. Numbered prefix when 2+ influences so the model can
  // address them as a menu rather than treat the second as a contradiction.
  const labelled = blocks.length === 1
    ? blocks[0]
    : blocks.map((b, i) => `(${i + 1}) ${b}`).join('\n\n');
  return `\n\nROAST CRAFT — channel these comedic registers when you trash-talk:\n${labelled}\n`;
}

module.exports = { STYLE_GUIDES, CHARACTER_INFLUENCES, styleGuideFor };
