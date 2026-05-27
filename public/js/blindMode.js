/**
 * Blind-mode accessibility module — terse TTS narration + push-to-talk
 * voice control of the poker table. Designed for Josh, a long-time
 * screen-reader user who's comfortable with fast speech (~1.7×).
 *
 * Entry points (wired from client.js):
 *   - Press `        toggle blind mode on/off (announced)
 *   - Hold Space     PTT mic — release to dispatch command
 *   - Speak "fold" / "check" / "call" / "raise 500" / "all in"
 *   - Voice queries  "what's the pot" / "what's my stack" / "what's the board"
 *                    "who's acting" / "repeat" / "faster" / "slower" / "blind off"
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
  // Written → phonetic spelling for names the TTS voice mispronounces.
  // Applied as a word-boundary case-insensitive replace in speak().
  // Add new entries when a screen-reader user reports a butchered name.
  const NAME_PRONUNCIATIONS = [
    ['Mandore',  'Man door'],
    ['Lirienne', 'Leery in'],
    ['Bujon',    'Boo han'],
  ];

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
    // "GP" / "gp" → "gold" so the synth says "two thousand gold"
    // instead of "two thousand GP" or letter-spelling "gee pee".
    text = text.replace(/\bgp\b/gi, 'gold');
    // Pronunciation fixes — written names the TTS engine routinely
    // mangles get spelled phonetically here so the screen-reader
    // voice says them correctly. Add new pairs as they surface.
    // Word-boundary match keeps it from corrupting substrings.
    for (const [orig, phon] of NAME_PRONUNCIATIONS) {
      text = text.replace(new RegExp(`\\b${orig}\\b`, 'gi'), phon);
    }
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
        const stack   = mePlayer?.stack ?? '?';
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
        line += ` ${toCallText} Pot ${Number(pot).toLocaleString()}. Stack ${Number(stack).toLocaleString()}.`;
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

    // Per-action lines — narration for spectators + the seated
    // player's inter-turn awareness. Filter to the CONSEQUENTIAL
    // actions only: raises, all-ins, folds. Routine "Kate calls
    // 200" and "Storgrim checks." lines are dropped — they don't
    // change the strategic picture and the constant cadence drowns
    // out the meaningful events. Bust/leave/rebuy/win still get
    // through via their own kinds below.
    if (kind === 'action') {
      const lower = text.toLowerCase();
      const isConsequential = /\b(raise|all[- ]?in|shove|fold)\b/.test(lower);
      if (!isConsequential) return;   // skip calls + checks
      speak(text, 'event');
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
  function startListening() {
    if (!state.on || !supportsSR || state.listening) return;
    try {
      const rec = new SR();
      rec.lang = 'en-US';
      rec.continuous = false;
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        const txt = (e.results?.[0]?.[0]?.transcript || '').trim();
        if (txt) processCommand(txt);
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
  /** Pull a positive integer out of natural speech.
   *  Supports digits ("500", "1500", "1k"), words ("five hundred",
   *  "two thousand five hundred"), and mixed ("2 thousand"). Returns
   *  null if nothing parseable found. */
  function parseAmount(text) {
    if (!text) return null;
    const t = String(text).toLowerCase().replace(/[,$]/g, '').trim();
    // Digit form, optionally with k/K suffix
    const digit = t.match(/(\d+(?:\.\d+)?)\s*([km])?/);
    if (digit) {
      const n = parseFloat(digit[1]);
      const mult = digit[2] === 'k' ? 1000 : digit[2] === 'm' ? 1_000_000 : 1;
      const v = Math.round(n * mult);
      if (Number.isFinite(v) && v > 0) return v;
    }
    // Word form
    const tokens = t.split(/[\s-]+/);
    let total = 0, current = 0, sawWord = false;
    for (const w of tokens) {
      if (ONES[w] != null)  { current += ONES[w]; sawWord = true; }
      else if (TEENS[w] != null) { current += TEENS[w]; sawWord = true; }
      else if (TENS[w] != null)  { current += TENS[w]; sawWord = true; }
      else if (w === 'hundred')  { current = (current || 1) * 100; sawWord = true; }
      else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; sawWord = true; }
      else if (w === 'k')        { total += (current || 1) * 1000; current = 0; sawWord = true; }
    }
    const v = total + current;
    return (sawWord && v > 0) ? v : null;
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

    // Mode + rate controls
    if (/^blind\s+off$/.test(raw)) { toggle(); return; }
    if (/^(faster|speed up)$/.test(raw)) { state.rate = Math.min(2.5, state.rate + 0.2); speak(`Rate ${state.rate.toFixed(1)}.`, 'urgent'); return; }
    if (/^(slower|slow down)$/.test(raw)) { state.rate = Math.max(0.8, state.rate - 0.2); speak(`Rate ${state.rate.toFixed(1)}.`, 'urgent'); return; }

    // Read-only queries
    if (/^repeat$/.test(raw)) { if (state.lastEventText) speak(state.lastEventText, 'urgent'); return; }
    if (/what.?s the pot|^pot$/i.test(raw)) { announcePot(); return; }
    if (/what.?s my stack|^stack$/i.test(raw)) { announceStack(); return; }
    if (/what.?s the board|^board$/i.test(raw)) { announceBoard(); return; }
    if (/who.?s acting|^actor$/i.test(raw)) { announceActor(); return; }
    if (/what.?s my hand|^hand$|^cards$|^hole$/i.test(raw)) {
      const hole = state.deps?.state?.myHole;
      if (hole && hole.length) speak(`Hole cards: ${cardListWords(hole)}.`, 'urgent');
      else speak('You have no hole cards right now.', 'urgent');
      return;
    }

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

    earcon('error');
    speak("Didn't catch that. Say fold, check, call, raise, or all in.", 'urgent');
  }

  function confirmThenDispatch(kind, amount) {
    // Soft-confirm raises ≥ half our stack; always confirm all-in.
    const mePid = state.deps?.state?.me?.player_id;
    const hand  = state.deps?.state?.table?.hand;
    const myStack = hand?.players?.find(p => p.playerId === mePid)?.stack ?? 0;
    const half = myStack / 2;
    const needsConfirm = kind === 'allin' || (kind === 'raise' && amount >= half && half > 0);
    if (!needsConfirm) { dispatchAction(kind, amount); return; }
    state.pendingConfirm = { kind, amount, expiresAt: Date.now() + 4500 };
    if (kind === 'allin') {
      speak(`All in for ${Number(myStack).toLocaleString()}. Say confirm to commit.`, 'urgent');
    } else {
      speak(`Raise ${Number(amount).toLocaleString()}. Say confirm to commit.`, 'urgent');
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
    if (Number.isFinite(inHand)) { speak(`Stack ${Number(inHand).toLocaleString()}.`, 'urgent'); return; }
    const seat = state.deps?.state?.table?.seats?.find(s => s.playerId === mePid);
    const chips = Number(seat?.chips || state.deps?.state?.me?.chips || 0);
    speak(`Stack ${chips.toLocaleString()}.`, 'urgent');
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

  // ---------- Init ----------
  function init(deps) {
    state.deps = deps;
    state.chipEl = deps.$('#blindModeChip');
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

  // Expose singleton
  window.BlindMode = {
    init, toggle, isOn, speak,
    onState, onChat, onHole,
    startListening, stopListening,
    notifyBanterStart,
  };
})();
