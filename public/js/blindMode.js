/**
 * Blind-mode accessibility module — terse TTS narration + push-to-talk
 * voice control of the poker table. Designed for Josh, a long-time
 * screen-reader user who's comfortable with fast speech (~1.7×).
 *
 * Entry points (wired from client.js):
 *   - Press `        toggle blind mode on/off (announced)
 *   - Press H        re-read my hand (hole cards + board)
 *   - Hold PTT key   push-to-talk mic — release to dispatch command
 *                    (default Space; rebindable — say "change push to talk")
 *   - Speak "fold" / "check" / "call" / "raise 500" / "all in"
 *   - Speak "sit" / "sit seat 3"  to take a seat hands-free
 *   - Voice queries  "what's the pot" / "what's my stack" / "what's the board"
 *                    "who's acting" / "hand" / "repeat" / "faster" / "slower"
 *                    "change push to talk" / "blind off"
 *
 * Design notes:
 *  - All state stays on this client (sessionStorage). Server is unaware.
 *  - 3-tier speech priority: urgent > event > ambient. Higher priority
 *    cancels in-flight + queue of lower; ambient is dropped if anything
 *    else is queued (keeps the audio from drifting behind reality).
 *  - PTT uses Web Speech Recognition (Chrome/Edge). Falls back with a
 *    toast on Firefox/Safari — keyboard shortcuts still work in that
 *    case (existing UI is unchanged underneath).
 *  - Hooks into existing socket events (table:state, table:chat,
 *    table:hole) so no new server protocol needed.
 *
 * Public API (singleton on window.BlindMode):
 *   init(deps)        wire keybinds, restore session, return ready flag
 *   toggle()          flip on/off
 *   isOn()            current mode
 *   speak(text,prio)  enqueue speech ('urgent'|'event'|'ambient')
 *   onState(state)    diff vs cached → narrate deltas
 *   onChat(entry)     filter + speak relevant chat events
 *   onHole(cards)     speak my hole cards privately
 */
(function () {
  'use strict';

  // ---------- Browser capability detection ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const TTS = window.speechSynthesis || null;
  const supportsTTS = !!TTS;
  const supportsSR  = !!SR;

  // ---------- Pronunciation overrides ----------
  // Written → phonetic spelling for names the TTS voice mispronounces,
  // applied as a word-boundary case-insensitive replace in speak().
  // SINGLE SOURCE OF TRUTH: this list is fetched from the backend on init
  // (GET /api/pronunciations), the SAME list the 11labs TTS uses — so a new
  // name is added in exactly one place (backend/src/util/pronunciations.js).
  // Starts empty; populated by the fetch in init(). If the fetch fails, names
  // just read literally (no crash).
  let NAME_PRONUNCIATIONS = [];

  // ---------- Divine-oath pauses ----------
  // "By Rovagug, those damn cards!" — the comma after an oath clause
  // barely pauses, so the line runs together. Upgrade that comma to an
  // ellipsis for a longer beat. Scoped to deity keywords so ordinary
  // commas are untouched. Mirror of backend/src/util/elevenlabs.js.
  const DIVINE_OATH_WORDS = [
    'Sarenrae', 'Dawnflower', 'Sunlord', 'Cayden', 'Gorum', 'Shelyn',
    'Pharasma', 'Desna', 'Iomedae', 'Inheritor', 'Calistria', 'Torag',
    'Droskar', 'Brigh', 'Casandalee', 'Asmodeus', 'Norgorber', 'Nethys',
    'Rovagug', 'Lamashtu', 'Aroden', 'Tar-Baphon', 'Abadar', 'Jezelda',
    'Zon-Kuthon', 'Erastil', 'Urgathoa', 'Gozreh',
  ];
  const OATH_RE = new RegExp(`\\b(${DIVINE_OATH_WORDS.join('|')})([\\w\\s'-]*?),`, 'gi');

  // ---------- State ----------
  const state = {
    on: false,
    rate: 1.7,                // TTS speed multiplier — Josh's sweet spot
    pitch: 1.0,
    voice: null,              // chosen voice object once available
    queue: [],                // [{text, prio}, ...]
    speaking: false,
    listening: false,
    rec: null,                // active SpeechRecognition instance
    // True while a banter audio clip is playing on this client (either
    // 11labs base64 or a local sound-pool URL). Acts as a gate: non-
    // urgent TTS waits until the audio ends; urgent TTS cancels the
    // audio so the cues don't overlap. Updated by client.js via the
    // exposed notifyBanterStart/End hooks.
    banterAudio: null,        // current Audio element, or null
    pendingConfirm: null,     // { kind:'raise', amount, expiresAt }
    lastEventText: null,      // for "repeat" command
    prevState: null,          // last seen table state, for diffing
    prevBoardLen: 0,          // last board card count
    prevActor: null,          // last actor playerId
    prevWinners: null,        // last winners snapshot id
    // Hand.startedAt for which we've already announced hole cards.
    // table:hole can fire multiple times per hand (initial deal,
    // state-rerender re-requests, reconnect re-emit) — dedup here
    // so the player only hears their cards ONCE at deal time, and
    // again later via the your-turn cue when the action's on them.
    spokenHoleHandStartedAt: null,
    deps: null,               // injected by init: {state, socket, toast, $}
    chipEl: null,             // topbar visual indicator
    // Push-to-talk key. Default is Space; a screen-reader user can
    // rebind it (some prefer to keep Space for their AT). Stored as a
    // KeyboardEvent.code so it's layout-independent. Persisted to
    // localStorage (survives reloads, unlike the sessionStorage mode flag).
    pttCode: 'Space',
    rebinding: false,         // true while capturing the next key as the new PTT
    rebindTimer: null,        // auto-cancel timer for a rebind that never completes
    announcedControls: false, // spoke the one-time "how to act" hint this session
  };

  // ---------- Earcons (WebAudio, no external assets) ----------
  let _audioCtx = null;
  function audioCtx() {
    if (!_audioCtx) {
      try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (_) { _audioCtx = null; }
    }
    return _audioCtx;
  }
  /** Play a short blip. `kind` selects pitch and duration:
   *   'open'  rising 600→900 Hz  — mic just opened
   *   'close' falling 900→600 Hz — mic just closed, processing
   *   'turn'  three 880 Hz pulses — your turn is up
   *   'error' two 220 Hz pulses — couldn't parse
   *   'ack'   single 1200 Hz blip — toggle / confirmation */
  function earcon(kind) {
    const ctx = audioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const make = (start, dur, freqStart, freqEnd, gain = 0.10) => {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.frequency.setValueAtTime(freqStart, start);
      if (freqEnd != null) osc.frequency.linearRampToValueAtTime(freqEnd, start + dur);
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(gain, start + 0.01);
      g.gain.linearRampToValueAtTime(0, start + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur);
    };
    if (kind === 'open')   make(now, 0.10, 600, 900);
    else if (kind === 'close') make(now, 0.10, 900, 600);
    else if (kind === 'turn')  { make(now, 0.07, 880); make(now + 0.10, 0.07, 880); make(now + 0.20, 0.07, 880); }
    else if (kind === 'error') { make(now, 0.10, 220); make(now + 0.13, 0.10, 220); }
    else if (kind === 'ack')   make(now, 0.08, 1200);
  }

  // ---------- TTS queue with 3-tier priority ----------
  const PRIO = { urgent: 3, event: 2, ambient: 1 };
  function speak(text, prio = 'event') {
    if (!state.on || !supportsTTS || !text) return;
    text = String(text);
    // Drop the currency word entirely. Josh asked for the bare number
    // ("call fifty", not "call fifty gold") to keep the cadence quick —
    // the unit is always gold at this table, so it's dead weight on the
    // ear. Strips "gp" AND "gold" (the latter in case a line already
    // spelled it out), eating the space before it so "50 gp." → "50."
    // The trailing period (sentence beat) is preserved.
    text = text.replace(/\s*\bg(?:p|old)\b/gi, '');
    // Pronunciation fixes — written names the TTS engine routinely
    // mangles get spelled phonetically here so the screen-reader
    // voice says them correctly. Add new pairs as they surface.
    // Word-boundary match keeps it from corrupting substrings.
    for (const [orig, phon] of NAME_PRONUNCIATIONS) {
      text = text.replace(new RegExp(`\\b${orig}\\b`, 'gi'), phon);
    }
    // Lengthen the pause after a divine-oath clause (see OATH_RE above).
    text = text.replace(OATH_RE, '$1$2...');
    const p = PRIO[prio] ?? PRIO.event;
    // ambient: drop if anything else is queued OR currently speaking
    if (p === PRIO.ambient && (state.queue.length > 0 || state.speaking)) return;
    // urgent: nuke everything queued + cancel in-flight + cut any
    // banter audio currently playing (so the cues never overlap).
    if (p === PRIO.urgent) {
      state.queue.length = 0;
      try { TTS.cancel(); } catch (_) {}
      if (state.banterAudio) {
        try { state.banterAudio.pause(); state.banterAudio.currentTime = 0; }
        catch (_) {}
        state.banterAudio = null;
      }
    } else {
      // event: drop in-flight + queued ambients, queue behind any active event
      state.queue = state.queue.filter(it => PRIO[it.prio] >= PRIO.event);
    }
    state.queue.push({ text, prio });
    if (prio === 'event') state.lastEventText = text;
    pump();
  }
  function pump() {
    if (state.speaking || !supportsTTS) return;
    // If a banter clip is currently playing, hold non-urgent TTS
    // until it finishes — we don't want the screen-reader voice
    // talking over a character voice (or vice versa). Urgent
    // utterances bypass this gate (see speak()'s urgent branch,
    // which cancels the banter audio outright before queuing).
    if (state.banterAudio && (state.queue[0]?.prio !== 'urgent')) return;
    const next = state.queue.shift();
    if (!next) return;
    const u = new SpeechSynthesisUtterance(next.text);
    u.rate  = state.rate;
    u.pitch = state.pitch;
    if (state.voice) u.voice = state.voice;
    u.onend = () => { state.speaking = false; pump(); };
    u.onerror = () => { state.speaking = false; pump(); };
    state.speaking = true;
    try { TTS.speak(u); }
    catch (_) { state.speaking = false; }
  }
  function pickVoice() {
    if (!supportsTTS) return;
    const vs = TTS.getVoices() || [];
    if (vs.length === 0) return;
    // Prefer en-US localService voices first.
    const en = vs.filter(v => /^en[-_]/i.test(v.lang));
    state.voice = en.find(v => v.localService)
               || en[0]
               || vs[0]
               || null;
  }

  // ---------- Mode toggle ----------
  function toggle() {
    if (!supportsTTS) {
      state.deps?.toast?.('Speech synthesis unavailable in this browser.', true);
      return;
    }
    state.on = !state.on;
    try { sessionStorage.setItem('blindMode', state.on ? '1' : '0'); } catch (_) {}
    updateChip();
    if (state.on) {
      earcon('ack');
      speak('Blind support on.', 'urgent');
      // If a hand is in progress, narrate where things stand RIGHT
      // NOW — the diff path only fires when something changes, so
      // without this a spectator who just turned on blind mode
      // would hear nothing until the next action. Then snapshot
      // current state so the normal diff doesn't re-announce the
      // same things on the next state event.
      const st = state.deps?.state?.table;
      const hand = st?.hand;
      if (hand && hand.state !== 'COMPLETE') {
        const seated = (st.seats || []).filter(s => s.occupied).length;
        speak(`Hand in progress. ${seated} players.`, 'event');
        const board = hand.board || [];
        if (board.length > 0) {
          const street = streetName(board.length);
          speak(`${street.charAt(0).toUpperCase() + street.slice(1)}: ${cardListWords(board)}.`, 'event');
        }
        const actor = currentActorId(st);
        if (actor) {
          const mePid = state.deps?.state?.me?.player_id;
          if (actor === mePid) {
            earcon('turn');
            speak('Your turn.', 'urgent');
          } else {
            speak(`${nickOf(st, actor)} to act.`, 'event');
          }
        }
      }
      // Snapshot AFTER announcing so the natural diff suppresses
      // duplicates next state event.
      state.prevState     = st || null;
      state.prevBoardLen  = hand?.board?.length || 0;
      state.prevActor     = currentActorId(st);
      state.prevWinners   = null;
    } else {
      // speak() short-circuits on state.on=false, so emit the goodbye
      // announcement directly. Then drain the queue + close mic.
      try { TTS.cancel(); } catch (_) {}
      state.queue.length = 0;
      stopListening();
      earcon('ack');
      try {
        const u = new SpeechSynthesisUtterance('Blind support off.');
        u.rate = state.rate; if (state.voice) u.voice = state.voice;
        TTS.speak(u);
      } catch (_) {}
    }
  }
  function isOn() { return state.on; }

  function updateChip() {
    if (!state.chipEl) return;
    state.chipEl.hidden = !state.on;
  }

  // ---------- Card / rank helpers ----------
  const RANK_WORD = {
    '2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight','9':'nine',
    'T':'ten','J':'jack','Q':'queen','K':'king','A':'ace',
    // pokersolver represents the low Ace in a wheel straight (A-2-3-4-5)
    // as '1h' / '1s' / etc. Keep it speaking as "ace" so Josh hears
    // the correct card instead of "one of hearts".
    '1':'ace',
  };
  const SUIT_WORD = { s:'spades', h:'hearts', d:'diamonds', c:'clubs' };
  function cardWords(code) {
    if (!code || code.length < 2) return '';
    return `${RANK_WORD[code[0].toUpperCase()] || code[0]} of ${SUIT_WORD[code[1].toLowerCase()] || ''}`.trim();
  }
  function cardListWords(cards) {
    return (cards || []).map(cardWords).filter(Boolean).join(', ');
  }

  // ---------- State diffing → narration ----------
  function currentActorId(st) {
    // Hand.publicState exposes the current actor as a playerId directly
    // (`hand.actor`), not a seat index. Null/falsy means hand is over or
    // between actions.
    if (!st || !st.hand) return null;
    const h = st.hand;
    if (h.state === 'COMPLETE') return null;
    return h.actor || null;
  }
  function seatBySeatIndex(st, idx) {
    return st?.seats?.[idx] || null;
  }
  function nickOf(st, playerId) {
    const s = (st?.seats || []).find(x => x.playerId === playerId);
    return s?.nickname || playerId || 'someone';
  }
  function streetName(boardLen) {
    if (boardLen === 0) return 'preflop';
    if (boardLen === 3) return 'flop';
    if (boardLen === 4) return 'turn';
    if (boardLen === 5) return 'river';
    return '';
  }

  /** Diff old vs new table state and emit one or two terse lines. */
  function onState(st) {
    if (!state.on || !st) return;
    const old = state.prevState;
    state.prevState = st;
    const hand = st.hand;

    // --- Hand start ---
    if (hand && (!old || old.hand?.startedAt !== hand.startedAt)) {
      const seats = (st.seats || []).filter(s => s.occupied).length;
      const mePid = state.deps?.state?.me?.player_id;
      const meSeat = mePid ? (st.seats || []).find(s => s.playerId === mePid) : null;
      let line = `New hand. ${seats} players.`;
      if (meSeat) {
        const seatNo = meSeat.index + 1;
        line += ` You are seat ${seatNo}.`;
      }
      speak(line, 'event');
      state.prevBoardLen = 0;
      state.prevActor = null;
      state.prevWinners = null;
      // Reset the spoken-hole tracker so the NEXT table:hole emit
      // (which carries the new deal's hole cards) speaks once and
      // only once for this fresh hand.
      state.spokenHoleHandStartedAt = null;
    }

    // --- Board reveal ---
    const board = hand?.board || [];
    if (board.length > state.prevBoardLen) {
      const newCards = board.slice(state.prevBoardLen);
      const street = streetName(board.length);
      if (street === 'flop') {
        speak(`Flop. ${cardListWords(newCards)}.`, 'event');
      } else if (street === 'turn') {
        speak(`Turn. ${cardListWords(newCards)}.`, 'event');
      } else if (street === 'river') {
        speak(`River. ${cardListWords(newCards)}.`, 'event');
      }
      state.prevBoardLen = board.length;
    }

    // --- Actor change ---
    const actor = currentActorId(st);
    if (actor && actor !== state.prevActor) {
      const mePid = state.deps?.state?.me?.player_id;
      if (actor === mePid) {
        // YOUR turn — urgent + earcon. Front-load the things you
        // can't see (your hole cards + the board) before the
        // numeric context (pot / stack / call amount).
        earcon('turn');
        const mePlayer = hand.players?.find(p => p.playerId === mePid);
        const pot     = hand.potTotal ?? 0;
        const myBet   = mePlayer?.invested ?? 0;
        const toMatch = (hand.currentBet ?? 0) - myBet;
        const toCallText = toMatch > 0 ? `To call ${toMatch.toLocaleString()}.` : 'You can check.';

        // Hole cards live on this client in state.deps.state.myHole
        // (private — only emitted to the owning player). Board
        // is on the public hand state.
        const hole = state.deps?.state?.myHole;
        const board = hand.board || [];
        let line = 'Your turn.';
        if (hole && hole.length) line += ` Hand: ${cardListWords(hole)}.`;
        if (board.length)        line += ` Board: ${cardListWords(board)}.`;
        // Cash is NOT read every turn (say "cash" to hear it on demand).
        line += ` ${toCallText} Pot ${Number(pot).toLocaleString()}.`;
        // One-time-per-session reminder of HOW to act — appended to the
        // first your-turn cue so a new blind player isn't left guessing.
        // Suppressed thereafter to keep the per-turn cue snappy.
        if (!state.announcedControls) {
          state.announcedControls = true;
          line += ` Hold ${pttLabel()} and say fold, call, or raise; press H to hear your hand again.`;
        }
        speak(line, 'urgent');
      }
      state.prevActor = actor;
    }
    if (!actor) state.prevActor = null;

    // --- Hand complete with winners ---
    if (hand?.state === 'COMPLETE' && hand.winners?.length) {
      const sig = hand.winners.map(w => `${w.playerId}:${w.amount}`).join('|');
      if (sig !== state.prevWinners) {
        state.prevWinners = sig;
        for (const w of hand.winners) {
          const nick = nickOf(st, w.playerId);
          const amt  = Number(w.amount || 0).toLocaleString();
          const hd   = w.handDesc ? ` with ${w.handDesc}` : '';
          speak(`${nick} wins ${amt}${hd}.`, 'event');
        }
      }
    }
  }

  /** Speak my own hole cards privately (only this client). Dedup
   *  per hand — the server can fire table:hole multiple times
   *  (initial deal, requestHole re-emits, reconnect path) and the
   *  player should only hear their cards once at deal time, not
   *  every time the state machine re-syncs. The your-turn cue
   *  re-announces hole + board when the action lands on them. */
  function onHole(cards) {
    if (!state.on || !cards || cards.length === 0) return;
    const startedAt = state.deps?.state?.table?.hand?.startedAt;
    if (startedAt && state.spokenHoleHandStartedAt === startedAt) return;
    state.spokenHoleHandStartedAt = startedAt || -1;
    speak(`Your hole cards: ${cardListWords(cards)}.`, 'event');
  }

  /** Filter chat entries by kind — speak only the meaningful ones.
   *  This is the main "play-by-play" path for blind users, ESPECIALLY
   *  spectators who never get the personal-turn cue. Server already
   *  formats each line concisely ("Kate calls 200.") — we just strip
   *  any leading emoji + prefix garbage so the TTS engine doesn't
   *  pronounce icons. */
  function onChat(entry) {
    if (!state.on || !entry || !entry.text) return;
    const kind = entry.kind || 'info';
    // Strip leading emoji / symbols / spaces so spoken output doesn't
    // start with "playing-cards black-joker" or similar nonsense.
    const text = entry.text.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (!text) return;

    // Per-action lines — the running play-by-play. A blind player can't
    // watch the felt, so EVERY action is narrated: "Kate folded.",
    // "Nomkath called 50 gold.", "Mr. Brow raised to 400 gold." The
    // server already formats these tersely; we just compact them a hair
    // more for the ear (drop the "to" in "raised to", collapse the
    // all-in parenthetical) and drop the bot tag word so the cadence
    // stays quick. Spoken at 'event' so a fresh action supersedes a
    // stale queued one but never cuts off the urgent your-turn cue.
    if (kind === 'action') {
      const compact = text
        .replace(/\braised to\b/i, 'raised')          // "raised to 400" → "raised 400"
        .replace(/\bwent ALL-IN\s*\(([^)]*)\)/i, 'all in $1'); // "went ALL-IN (400 gp)" → "all in 400 gp"
      speak(compact, 'event');
      return;
    }

    // Hand-boundary + win lines duplicate onState narration; skip
    // them to avoid double-speak for seated users (who get the
    // hand-start and winner announcements via the diff path).
    if (kind === 'hand') return;
    if (kind === 'win')  return;

    // Banter is voiced separately via the 11labs/audio attachment
    // on the chat broadcast (or local sound pool for Crisp/Elfrip).
    // Don't TTS the text again.
    if (kind === 'banter') return;

    // Real-human chat at ambient priority — auto-drops if anything
    // higher-priority is queued.
    if (kind === 'human') { speak(text, 'ambient'); return; }

    // Everything else (rebuy, leave, debt, info, lootlord) is an event.
    speak(text, 'event');
  }

  // ---------- Speech recognition (PTT) ----------
  // Marks a transcript as a likely command, so we can pick the best of
  // several speech-recognition alternatives instead of blindly trusting
  // the top guess. Covers actions, queries, and confirm words.
  const COMMAND_HINT = /\b(fold|check|call|raise|bet|all\s*in|shove|jam|min|pot|stack|cash|board|hand|cards|hole|repeat|sit|seat|faster|slower|confirm|yes|no|cancel|change|push)\b/;
  function startListening() {
    if (!state.on || !supportsSR || state.listening) return;
    // BARGE-IN: silence our own narration the instant the mic opens, so
    // the player can talk OVER a long cue ("Your turn. Hand... Board...
    // Pot... Cash...") and interrupt with "check". Essential because:
    //   1) otherwise the recognizer picks up the TTS voice bleeding from
    //      the speakers and mis-hears — or worse, a play-by-play line like
    //      "Kate checked" gets recognized as a command; and
    //   2) a blind player shouldn't have to wait out a sentence to act.
    // We clear the queue too, so nothing resumes after they've spoken.
    try { TTS.cancel(); } catch (_) {}
    state.queue.length = 0;
    state.speaking = false;
    if (state.banterAudio) {
      try { state.banterAudio.pause(); state.banterAudio.currentTime = 0; } catch (_) {}
      state.banterAudio = null;
    }
    try {
      const rec = new SR();
      rec.lang = 'en-US';
      rec.continuous = false;
      rec.interimResults = false;
      // Ask for several guesses, not just the top one. Speech-to-text
      // frequently misranks short utterances — especially numbers — so we
      // prefer the highest-confidence alternative that actually looks like
      // a command ("raise 500") over a junk top guess ("phrase 500").
      rec.maxAlternatives = 4;
      rec.onresult = (e) => {
        const res = e.results?.[0];
        if (!res) return;
        const alts = [];
        for (let i = 0; i < res.length; i++) {
          const tr = (res[i]?.transcript || '').trim();
          if (tr) alts.push(tr);
        }
        if (!alts.length) return;
        const chosen = alts.find(a => COMMAND_HINT.test(a.toLowerCase())) || alts[0];
        processCommand(chosen);
      };
      rec.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        earcon('error');
      };
      rec.onend = () => { state.listening = false; state.rec = null; };
      rec.start();
      state.listening = true;
      state.rec = rec;
      earcon('open');
    } catch (_) { /* swallow */ }
  }
  function stopListening() {
    if (!state.listening || !state.rec) return;
    try { state.rec.stop(); } catch (_) {}
    earcon('close');
  }

  // ---------- Spoken-number parsing ----------
  const ONES  = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9 };
  const TEENS = { ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19 };
  const TENS  = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
  /** Pull a positive integer out of natural speech. Handles a SINGLE
   *  unified token stream so digits and multiplier words combine correctly:
   *    "500"                  → 500
   *    "five hundred"         → 500
   *    "5 hundred"            → 500   (speech-to-text loves this form)
   *    "2 thousand"           → 2000
   *    "fifteen hundred"      → 1500
   *    "two thousand five hundred" → 2500
   *    "1k" / "2.5k" / "1m"   → 1000 / 2500 / 1000000
   *    "500 gold" / "to 500"  → 500  (filler words ignored)
   *  The old version had a digit shortcut that returned on the first
   *  number and dropped a trailing "hundred"/"thousand" — so "5 hundred"
   *  parsed as 5. Returns null if nothing parseable is found. */
  function parseAmount(text) {
    if (!text) return null;
    const t = String(text).toLowerCase().replace(/[,$]/g, ' ').replace(/-+/g, ' ').trim();
    if (!t) return null;
    const tokens = t.split(/\s+/).filter(Boolean);
    let total = 0, current = 0, sawValue = false;
    for (const tok of tokens) {
      // Plain digits with an optional k/m magnitude suffix.
      const dm = tok.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
      if (dm) {
        let v = parseFloat(dm[1]);
        if (dm[2] === 'k') v *= 1000;
        else if (dm[2] === 'm') v *= 1_000_000;
        current += v; sawValue = true;
        continue;
      }
      if (ONES[tok]  != null) { current += ONES[tok];  sawValue = true; continue; }
      if (TEENS[tok] != null) { current += TEENS[tok]; sawValue = true; continue; }
      if (TENS[tok]  != null) { current += TENS[tok];  sawValue = true; continue; }
      if (tok === 'hundred') { current = (current || 1) * 100; sawValue = true; continue; }
      if (tok === 'thousand' || tok === 'k') { total += (current || 1) * 1000;      current = 0; sawValue = true; continue; }
      if (tok === 'million'  || tok === 'm') { total += (current || 1) * 1_000_000; current = 0; sawValue = true; continue; }
      // Unknown token (to, by, gold, chips, and, please…) → ignore.
    }
    const v = Math.round(total + current);
    return (sawValue && v > 0) ? v : null;
  }

  // ---------- Command parsing & dispatch ----------
  function processCommand(transcript) {
    const raw = transcript.toLowerCase().trim();
    // Pending confirm: only the literal "confirm" or "yes" goes through.
    if (state.pendingConfirm && Date.now() < state.pendingConfirm.expiresAt) {
      if (/^(confirm|yes|do it|go)$/.test(raw)) {
        dispatchAction(state.pendingConfirm.kind, state.pendingConfirm.amount);
        state.pendingConfirm = null;
        return;
      }
      if (/^(no|cancel|abort|stop)$/.test(raw)) {
        state.pendingConfirm = null;
        speak('Cancelled.', 'urgent');
        return;
      }
    }
    state.pendingConfirm = null;

    // In the dungeon side-game, route to the dungeon command set first.
    if (document.body.dataset.screen === 'dungeon') {
      if (handleDungeonCommand(raw)) return;
      // Otherwise fall through (repeat / rate / blind off still work).
    } else if (/^(dungeon|hit the dungeon|enter(?:\s+the)?\s+dungeon|go to the dungeon)$/.test(raw)) {
      state.deps?.enterDungeon?.();
      return;
    }

    // Mode + rate controls
    if (/^blind\s+off$/.test(raw)) { toggle(); return; }
    if (/^(faster|speed up)$/.test(raw)) { state.rate = Math.min(2.5, state.rate + 0.2); speak(`Rate ${state.rate.toFixed(1)}.`, 'urgent'); return; }
    if (/^(slower|slow down)$/.test(raw)) { state.rate = Math.max(0.8, state.rate - 0.2); speak(`Rate ${state.rate.toFixed(1)}.`, 'urgent'); return; }
    // Rebind the push-to-talk key by voice.
    if (/^(change|set|rebind)\s+(my\s+)?(push[\s-]?to[\s-]?talk|talk|mic|ptt)(\s+key)?$/.test(raw)) { beginRebind(); return; }

    // Seating — "sit", "sit down", "take a seat", or "sit seat 3".
    const sitSeat = raw.match(/^(?:sit|take)\s+(?:in\s+)?seat\s+(\d+)$/);
    if (sitSeat) { sit(parseInt(sitSeat[1], 10) - 1); return; }
    if (/^(sit|sit down|take a seat|sit me down)$/.test(raw)) { sit(); return; }

    // Read-only queries
    if (/^repeat$/.test(raw)) { if (state.lastEventText) speak(state.lastEventText, 'urgent'); return; }
    if (/what.?s the pot|^pot$/i.test(raw)) { announcePot(); return; }
    if (/what.?s my (stack|cash)|^stack$|^cash$/i.test(raw)) { announceStack(); return; }
    if (/what.?s the board|^board$/i.test(raw)) { announceBoard(); return; }
    if (/who.?s acting|^actor$/i.test(raw)) { announceActor(); return; }
    if (/what.?s my hand|^hand$|^cards$|^hole$/i.test(raw)) { readHand(); return; }

    // Game actions
    if (/^fold$/.test(raw)) { dispatchAction('fold'); return; }
    if (/^check$/.test(raw)) { dispatchAction('check'); return; }
    if (/^call$/.test(raw))  { dispatchAction('call'); return; }
    if (/^(all\s*in|shove)$/.test(raw)) { confirmThenDispatch('allin', null); return; }
    if (/^min(imum)?\s*raise$/.test(raw)) {
      const min = minRaiseAmount();
      if (min == null) { speak('No minimum raise available.', 'urgent'); return; }
      confirmThenDispatch('raise', min);
      return;
    }
    // Special "raise pot" must match BEFORE the general raise regex,
    // otherwise the word "pot" gets fed to the amount parser and fails.
    if (/^raise\s+pot$/.test(raw)) {
      const hand = state.deps?.state?.table?.hand;
      const amt = Number(hand?.potTotal || 0);
      if (amt > 0) { confirmThenDispatch('raise', amt); return; }
      speak('Pot is zero.', 'urgent');
      return;
    }
    // "raise by X" → bump current bet by X. Must match before the
    // general "raise X" regex below for the same reason as "raise pot".
    const raiseBy = raw.match(/^raise\s+by\s+(.+)$/);
    if (raiseBy) {
      const inc = parseAmount(raiseBy[1]);
      if (inc == null) { earcon('error'); speak("Didn't catch the amount. Say again.", 'urgent'); return; }
      const cur = Number(state.deps?.state?.table?.hand?.currentBet || 0);
      confirmThenDispatch('raise', cur + inc);
      return;
    }
    // "raise X" / "raise to X" → raise TO X (new total bet) — matches
    // both the existing raise-input UI and live-poker convention.
    const raiseM = raw.match(/^raise(?:\s+to)?\s+(.+)$/);
    if (raiseM) {
      const amt = parseAmount(raiseM[1]);
      if (amt == null) { earcon('error'); speak("Didn't catch the amount. Say again.", 'urgent'); return; }
      confirmThenDispatch('raise', amt);
      return;
    }

    // Routine regexes didn't match. Before giving up, hand the raw phrase
    // to the server-side LLM interpreter, which maps loose / unclear speech
    // ("I'm out", "bump it to five hundred", "see the bet") to a concrete
    // action. The result is always CONFIRMED aloud before it's dispatched.
    interpretViaLLM(raw);
  }

  /** Last-resort: ask the backend (Ollama) to interpret an unparsed phrase,
   *  then stage the guessed action behind an explicit yes/no confirm so an
   *  LLM mistake can't act on its own. Falls back to a spoken error if the
   *  model is unreachable, slow, or returns nothing usable. */
  function interpretViaLLM(transcript) {
    const socket = state.deps?.socket;
    if (!socket || !transcript) {
      earcon('error');
      speak("Didn't catch that. Say fold, check, call, raise, or all in.", 'urgent');
      return;
    }
    speak('One moment.', 'urgent');
    let done = false;
    const fail = () => {
      if (done) return; done = true;
      earcon('error');
      speak("Sorry, I couldn't work that out. Try fold, call, raise, or all in.", 'urgent');
    };
    // Safety net: blind:interpret has no server ack if the handler is
    // missing (old backend) or the model hangs past its own timeout.
    const guard = setTimeout(fail, 10000);
    socket.emit('blind:interpret', { transcript }, (resp) => {
      if (done) return; done = true;
      clearTimeout(guard);
      const action = resp?.action;
      if (!resp?.ok || !action || action === 'none') { fail(); return; }
      const amount = resp.amount;
      const label = action === 'raise'
        ? `raise to ${Number(amount).toLocaleString()}`
        : action === 'allin' ? 'all in'
        : action;
      // Stage behind the existing pendingConfirm gate (checked at the top
      // of processCommand): the player's next "yes" dispatches it, "no"
      // cancels. Generous window — they must re-engage push-to-talk first.
      state.pendingConfirm = {
        kind: action,
        amount: action === 'raise' ? amount : null,
        expiresAt: Date.now() + 10000,
      };
      earcon('turn');
      speak(`I heard ${label}. Say yes to do it, or no to cancel.`, 'urgent');
    });
  }

  function confirmThenDispatch(kind, amount) {
    // ALWAYS read a raise/all-in back and wait for "yes" before committing
    // chips. Speech-to-text mishears numbers ("five hundred" → "5 hundred",
    // "500" → "5,000"), so the read-back is the safety net that lets the
    // player catch a wrong amount — and disambiguates raise-TO vs raise-BY,
    // since they hear the resulting total. Fold / check / call don't pass
    // through here; they dispatch directly (cheap, no number to mishear).
    const mePid = state.deps?.state?.me?.player_id;
    const hand  = state.deps?.state?.table?.hand;
    const myStack = hand?.players?.find(p => p.playerId === mePid)?.stack ?? 0;
    // Generous window — with barge-in the player must re-press push-to-talk
    // and say "yes", which takes a few seconds.
    state.pendingConfirm = { kind, amount, expiresAt: Date.now() + 12000 };
    if (kind === 'allin') {
      speak(`All in for ${Number(myStack).toLocaleString()}. Say yes to commit, or no to cancel.`, 'urgent');
    } else {
      speak(`Raise to ${Number(amount).toLocaleString()}. Say yes to commit, or no to cancel.`, 'urgent');
    }
  }
  function dispatchAction(kind, amount) {
    const socket = state.deps?.socket;
    if (!socket) { earcon('error'); return; }
    const payload = { action: kind };
    if (kind === 'raise' && Number.isFinite(amount)) payload.amount = amount;
    socket.emit('table:action', payload, (resp) => {
      if (!resp?.ok) {
        earcon('error');
        speak(resp?.error || 'Action rejected.', 'urgent');
      }
    });
  }
  function minRaiseAmount() {
    // Per Hand.publicState: minRaise = the minimum raise INCREMENT (last
    // raise size, or BB at start). New total = currentBet + minRaise.
    const hand = state.deps?.state?.table?.hand;
    if (!hand) return null;
    const cur = Number(hand.currentBet || 0);
    const inc = Number(hand.minRaise || 0);
    if (!inc) return null;
    return cur + inc;
  }

  // ---------- Read-only voice queries ----------
  function announcePot() {
    const hand = state.deps?.state?.table?.hand;
    const pot = hand?.potTotal ?? 0;
    speak(`Pot ${Number(pot).toLocaleString()}.`, 'urgent');
  }
  function announceStack() {
    const mePid = state.deps?.state?.me?.player_id;
    const hand  = state.deps?.state?.table?.hand;
    const inHand = hand?.players?.find(p => p.playerId === mePid)?.stack;
    if (Number.isFinite(inHand)) { speak(`Cash ${Number(inHand).toLocaleString()}.`, 'urgent'); return; }
    const seat = state.deps?.state?.table?.seats?.find(s => s.playerId === mePid);
    const chips = Number(seat?.chips || state.deps?.state?.me?.chips || 0);
    speak(`Cash ${chips.toLocaleString()}.`, 'urgent');
  }
  function announceBoard() {
    const board = state.deps?.state?.table?.hand?.board || [];
    if (!board.length) { speak('No board yet.', 'urgent'); return; }
    speak(`Board: ${cardListWords(board)}.`, 'urgent');
  }
  function announceActor() {
    const st = state.deps?.state?.table;
    const a = currentActorId(st);
    if (!a) { speak('Nobody is acting.', 'urgent'); return; }
    const mePid = state.deps?.state?.me?.player_id;
    if (a === mePid) speak('Your turn.', 'urgent');
    else speak(`${nickOf(st, a)} is acting.`, 'urgent');
  }

  /** Re-read the player's current hole cards on demand. Bound to the H
   *  key and the "hand"/"cards" voice query — the answer to "wait, what
   *  was I holding?" without waiting for the next turn cue. */
  function readHand() {
    if (!state.on) return;
    const hole = state.deps?.state?.myHole;
    if (hole && hole.length) {
      const board = state.deps?.state?.table?.hand?.board || [];
      let line = `Your hand: ${cardListWords(hole)}.`;
      if (board.length) line += ` Board: ${cardListWords(board)}.`;
      speak(line, 'urgent');
    } else {
      speak('You have no cards right now.', 'urgent');
    }
  }

  /** Sit the player into a seat by voice/command. With no index, takes
   *  the lowest-numbered open seat. Routes through the sit() callback
   *  injected by client.js (which owns the socket join flow). */
  function sit(seatIndex) {
    if (!state.on) return;
    const doSit = state.deps?.sit;
    if (typeof doSit !== 'function') { earcon('error'); return; }
    const seats = state.deps?.state?.table?.seats || [];
    let idx = seatIndex;
    if (idx == null) {
      const open = seats.find(s => !s.occupied);
      if (!open) { speak('No open seats.', 'urgent'); return; }
      idx = open.index;
    } else {
      const target = seats.find(s => s.index === idx);
      if (!target) { speak(`No seat ${idx + 1}.`, 'urgent'); return; }
      if (target.occupied) { speak(`Seat ${idx + 1} is taken.`, 'urgent'); return; }
    }
    speak(`Taking seat ${idx + 1}.`, 'urgent');
    doSit(idx);
  }

  // ---------- Push-to-talk key (configurable) ----------
  /** Human-readable name for a KeyboardEvent.code, for spoken prompts. */
  function codeLabel(code) {
    if (!code) return 'that key';
    if (code === 'Space') return 'the space bar';
    if (code.startsWith('Key')) return code.slice(3);            // KeyT → "T"
    if (code.startsWith('Digit')) return code.slice(5);          // Digit4 → "4"
    if (code.startsWith('Numpad')) return 'numpad ' + code.slice(6);
    const named = {
      Enter: 'enter', Tab: 'tab', Backslash: 'backslash', Slash: 'slash',
      Semicolon: 'semicolon', Quote: 'quote', Period: 'period', Comma: 'comma',
      ShiftRight: 'right shift', ShiftLeft: 'left shift', ControlRight: 'right control',
      AltRight: 'right alt', Backquote: 'backtick',
    };
    return named[code] || code;
  }
  function pttLabel() { return codeLabel(state.pttCode); }
  function getPttCode() { return state.pttCode || 'Space'; }
  function isRebinding() { return state.rebinding; }
  /** Start capturing the next keypress as the new PTT key. The keydown
   *  handler in client.js funnels the very next key here via consumeRebind. */
  function beginRebind() {
    if (!state.on) return;
    state.rebinding = true;
    earcon('open');
    speak('Press the key you want to hold to talk. Press escape to cancel.', 'urgent');
    clearTimeout(state.rebindTimer);
    state.rebindTimer = setTimeout(() => {
      if (state.rebinding) { state.rebinding = false; speak('Push to talk unchanged.', 'urgent'); }
    }, 8000);
  }
  /** Consume a captured key as the new PTT binding. Returns true if it
   *  was handled (so the caller can preventDefault + swallow it). Rejects
   *  modifier-only keys and the backtick toggle so the bind stays usable. */
  function consumeRebind(code) {
    if (!state.rebinding) return false;
    clearTimeout(state.rebindTimer);
    if (code === 'Escape') {
      state.rebinding = false;
      speak('Cancelled. Push to talk unchanged.', 'urgent');
      return true;
    }
    const isModifier = /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code);
    if (!code || isModifier || code === 'Backquote') {
      speak('That key is reserved. Pick another.', 'urgent');
      // stay in rebind mode, reset the timeout
      state.rebindTimer = setTimeout(() => {
        if (state.rebinding) { state.rebinding = false; }
      }, 8000);
      return true;
    }
    state.rebinding = false;
    state.pttCode = code;
    try { localStorage.setItem('blindPttCode', code); } catch (_) {}
    earcon('ack');
    speak(`Push to talk set to ${codeLabel(code)}.`, 'urgent');
    return true;
  }

  // ---------- Init ----------
  function init(deps) {
    state.deps = deps;
    state.chipEl = deps.$('#blindModeChip');
    // Pull the canonical name-pronunciation list from the backend (the same
    // list the 11labs voices use). Best-effort — names read literally on
    // failure. Same origin as the page, so it's as reliable as the game.
    try {
      fetch('/api/pronunciations')
        .then(r => (r.ok ? r.json() : null))
        .then(list => { if (Array.isArray(list)) NAME_PRONUNCIATIONS = list; })
        .catch(() => {});
    } catch (_) {}
    // Restore the custom push-to-talk key (localStorage — persists across
    // reloads). Falls back to Space when unset or storage is blocked.
    try {
      const savedPtt = localStorage.getItem('blindPttCode');
      if (savedPtt) state.pttCode = savedPtt;
    } catch (_) {}
    // Restore mode from sessionStorage
    try {
      const stored = sessionStorage.getItem('blindMode');
      if (stored === '1' && supportsTTS) {
        // Late-restore: announce silently (no earcon on cold start to
        // avoid surprising sighted users sharing the tab).
        state.on = true;
        updateChip();
      }
    } catch (_) {}
    // Voices populate async on some browsers.
    if (supportsTTS) {
      pickVoice();
      TTS.onvoiceschanged = pickVoice;
    }
    if (!supportsTTS) {
      console.warn('[blindMode] speechSynthesis unavailable — TTS disabled');
    }
    if (!supportsSR) {
      console.warn('[blindMode] speech recognition unavailable — PTT disabled');
    }
    return { supportsTTS, supportsSR };
  }

  // Called by client.js when a banter audio clip starts/ends. While
  // an audio element is registered as the active banter source,
  // pump() will hold non-urgent TTS — keeps the character voice and
  // the screen-reader narration from talking over each other. The
  // hook is a no-op when blind mode is off, but we still track the
  // current Audio element so urgent toggle-on doesn't double up.
  function notifyBanterStart(audioEl) {
    if (!audioEl) return;
    state.banterAudio = audioEl;
    // Auto-clear on end / error so we don't deadlock the queue if
    // the play() call rejected silently.
    const clear = () => {
      if (state.banterAudio === audioEl) {
        state.banterAudio = null;
        pump();
      }
    };
    audioEl.addEventListener('ended', clear, { once: true });
    audioEl.addEventListener('error', clear, { once: true });
    audioEl.addEventListener('pause', clear, { once: true });
  }

  // ====================================================================
  //  🗡️ Dungeon side-game — spoken narration + voice control
  // ====================================================================
  // Lets a blind player follow and play the dungeon entirely by ear + voice.
  // Narration fires from onDungeonState (wired in client.js); voice commands
  // are dispatched from processCommand's dungeon branch above.
  const _dun = { depth: -1, logT: 0, turnKey: '', status: '', lootKey: '' };

  function _stripGlyphs(s) {
    // Drop bracketed roll math ([d20 14 +3 = 17 vs AC 15]) and emoji so the
    // spoken line stays clean — the numbers stay visible in the on-screen log.
    try { return String(s || '').replace(/\[[^\]]*\]/g, '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim(); }
    catch (_) { return String(s || '').replace(/\[[^\]]*\]/g, '').trim(); }
  }
  function _dunEnemyPhrase(d) {
    const alive = (d.enemies || []).filter(e => e.alive);
    if (!alive.length) return 'No enemies.';
    if (alive.length === 1) return `Enemy: ${alive[0].name}, ${alive[0].hp} hit points${alive[0].sickened ? ', sickened' : ''}.`;
    return `${alive.length} enemies. ` + alive.map((e, i) => `${i + 1}: ${e.name}, ${e.hp}${e.sickened ? ', sickened' : ''}`).join('. ') + '.';
  }
  // "Say attack, <ability 1>, <ability 2>, or bail." built from the player's kit.
  function _dunActionsHint(d) {
    const meId = state.deps?.state?.me?.player_id;
    const kit = ((d.party || []).find(m => m.playerId === meId) || {}).kit;
    const names = kit ? (kit.abilities || []).map(a => a && a.name).filter(Boolean) : [];
    const atk = (kit && kit.atwill && kit.atwill.name) || 'attack';
    if (names.length) return `Say ${atk.toLowerCase()}, ${names.join(', ')}, or bail. Add a number to target, like ${atk.toLowerCase()} two.`;
    return 'Say attack, ability one, ability two, or bail. Add a number to target.';
  }
  function _dunNarrateFull(d) {
    const me = (d.party||[]).find(m => m.playerId === (state.deps?.state?.me?.player_id)) || {};
    const bits = [`Depth ${d.depth}.`, `You have ${me.hp} of ${me.maxHp} hit points.`, _dunEnemyPhrase(d), `${d.runGold} gold this run.`];
    if (d.status === 'exploring') bits.push('Say open to descend, or bail to leave.');
    else if (d.status === 'combat') bits.push(_dunActionsHint(d));
    speak(bits.join(' '), 'urgent');
  }

  // Called from client.js on every dungeon:state push.
  function onDungeonState(st) {
    if (!state.on || !st) return;
    const meId = state.deps?.state?.me?.player_id;

    // New room / entry.
    if (st.depth !== _dun.depth) {
      _dun.depth = st.depth;
      if (st.depth === 0) speak('You enter the dungeon. Say open to descend, or bail to leave.', 'event');
      else speak(`Room ${st.depth}. ${_dunEnemyPhrase(st)}`, 'event');
    }
    // New combat-log lines (results) — speak the freshest, stripped of emoji.
    if (Array.isArray(st.log) && st.log.length) {
      const fresh = st.log.filter(e => e.t > _dun.logT);
      if (fresh.length) {
        _dun.logT = Math.max(_dun.logT, ...st.log.map(e => e.t));
        for (const e of fresh.slice(-2)) { const t = _stripGlyphs(e.text); if (t) speak(t, 'event'); }
      }
    }
    // Turn changes.
    const turnKey = st.turn ? `${st.turn.kind}:${st.turn.id}:${st.round}` : `${st.status}`;
    if (turnKey !== _dun.turnKey) {
      _dun.turnKey = turnKey;
      if (st.status === 'combat' && st.turn && st.turn.kind === 'party' && st.turn.id === meId) {
        const me = (st.party||[]).find(m => m.playerId === meId) || {};
        speak(`Your turn. ${me.hp} hit points. ${_dunEnemyPhrase(st)} ${_dunActionsHint(st)}`, 'urgent');
      } else if (st.status === 'exploring' && _dun.status === 'combat') {
        speak('Room clear. Open the next door, or bail with your gold.', 'event');
      }
    }
    // Run end.
    if (st.status !== _dun.status) {
      const prev = _dun.status; _dun.status = st.status;
      if (st.status === 'dead') speak('You have fallen in the dungeon. The run is lost.', 'urgent');
      else if (st.status === 'bailed' && prev) speak(`You climbed out with ${st.runGold} gold.`, 'urgent');
    }
    // Loot roll prompt (only when it's mine to decide).
    const lr = st.lootRoll, lrKey = lr ? `${lr.slot}:${lr.tier}` : '';
    if (lrKey !== _dun.lootKey) {
      _dun.lootKey = lrKey;
      if (lr && (lr.eligible || []).includes(meId) && (lr.decided || {})[meId] === undefined) {
        speak(`A plus ${lr.tier} ${lr.label} dropped. Say roll to roll a d20 for it, or pass.`, 'urgent');
      }
    }
  }

  // Voice command set while on the dungeon screen. Returns true if handled.
  function handleDungeonCommand(raw) {
    const d = state.deps?.state?.dungeon;
    const socket = state.deps?.socket;
    if (!d || !socket) return false;
    const alive = (d.enemies || []).filter(e => e.alive);
    const emit = (kind, payload) => socket.emit('dungeon:action', { kind, ...(payload || {}) }, () => {});
    const meId = state.deps?.state?.me?.player_id;

    // Loot roll-off (only my decision is routed here).
    if (d.lootRoll && (d.lootRoll.eligible || []).includes(meId) && (d.lootRoll.decided || {})[meId] === undefined) {
      if (/^(roll|roll for it|roll loot|roll the loot|roll a d20|i roll)$/.test(raw)) { emit('lootroll', { roll: true }); return true; }
      if (/^(pass|pass on it|pass loot|skip loot|i pass)$/.test(raw)) { emit('lootroll', { roll: false }); return true; }
    }

    // Queries
    if (/^(read|status|state|where am i|situation)$/.test(raw)) { _dunNarrateFull(d); return true; }
    if (/^(enemies|targets|who.?s here)$/.test(raw)) { speak(_dunEnemyPhrase(d), 'urgent'); return true; }
    if (/^(hp|health|my health|my hp)$/.test(raw)) { const me = (d.party||[]).find(m => m.playerId === (state.deps?.state?.me?.player_id)) || {}; speak(`${me.hp} of ${me.maxHp} hit points.`, 'urgent'); return true; }
    if (/^(gold|my gold|loot)$/.test(raw)) { speak(`${d.runGold} gold this run.`, 'urgent'); return true; }
    // Actions
    if (/^(open|door|next|deeper|descend|go down|go deeper)$/.test(raw)) { emit('door'); return true; }
    if (/^(bail|leave|climb out|retreat|get out|escape|go up|surface)$/.test(raw)) { emit('bail'); return true; }
    if (/^equip$/.test(raw)) { emit('equip', { idx: 0 }); return true; }
    if (/^(hock|sell)$/.test(raw)) { emit('hock', { idx: 0 }); return true; }
    // Class abilities — by slot ("ability one/two") or by spoken name ("fireball",
    // "trip", "smite"). A trailing number targets that enemy.
    const myKit = ((d.party || []).find(m => m.playerId === meId) || {}).kit;
    if (myKit && Array.isArray(myKit.abilities)) {
      const allUids = alive.map(e => e.uid).slice(0, 6);
      let slot = null, tnum = null;
      const sm = raw.match(/^(?:ability|power|cast|use)\s+(one|1|first|two|2|second)(?:\s+(\d+))?$/);
      if (sm) { slot = /^(two|2|second)$/.test(sm[1]) ? 1 : 0; tnum = sm[2] ? parseInt(sm[2], 10) - 1 : null; }
      if (slot === null) {
        const idx = myKit.abilities.findIndex(a => a && (raw.startsWith(String(a.name || '').toLowerCase()) || raw.startsWith(String(a.key || '').toLowerCase())));
        if (idx >= 0) { slot = idx; const nm = raw.match(/(\d+)\s*$/); tnum = nm ? parseInt(nm[1], 10) - 1 : null; }
      }
      if (slot !== null && myKit.abilities[slot] && myKit.abilities[slot].available === false) {
        speak(`${myKit.abilities[slot].name} unlocks at level ${myKit.abilities[slot].minLevel}.`, 'urgent');
        return true;
      }
      if (slot !== null) {
        const uid = (tnum != null ? alive[tnum] : alive[0])?.uid;
        emit('ability', { slot, targetUid: uid, targetUids: allUids });
        return true;
      }
    }
    const am = raw.match(/^(?:attack|hit|strike|swing|stab)(?:\s+(\d+))?$/);
    if (am) {
      const i = am[1] ? parseInt(am[1], 10) - 1 : 0;
      emit('attack', { targetUid: (alive[i] || alive[0])?.uid });
      return true;
    }
    return false;
  }

  // Expose singleton
  window.BlindMode = {
    init, toggle, isOn, speak,
    onState, onChat, onHole, onDungeonState,
    startListening, stopListening,
    notifyBanterStart,
    // Turn-controls + seating helpers (bound to keys in client.js)
    readHand, sit,
    // Configurable push-to-talk binding
    getPttCode, isRebinding, beginRebind, consumeRebind, pttLabel,
  };
})();
