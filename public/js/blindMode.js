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

  // ---------- Diagnostic logging ----------
  // Thorough, prefixed console logging so a (possibly remote) blind tester's
  // session can be debugged after the fact — ESPECIALLY *why* push-to-talk
  // speech recognition fails to start (capability flags, secure-context,
  // mic-permission error codes). On by default; silence with
  //   localStorage.blindModeDebug = '0'
  // Recent entries are also kept in a ring buffer reachable from the console
  // via  window.BlindMode.getLogs()  so the tester can copy/paste them.
  let DEBUG = true;
  try { if (localStorage.getItem('blindModeDebug') === '0') DEBUG = false; } catch (_) {}
  const _logs = [];   // ring buffer for getLogs() (local console retrieval)
  const _ship = [];   // pending entries to stream to the server (allow-listed players)
  function blog(...args) {
    let body;
    try {
      body = args.map(a => (a == null || typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean')
        ? String(a) : JSON.stringify(a)).join(' ');
    } catch (_) { body = args.join(' '); }
    let stamp = '';
    try { stamp = new Date().toLocaleTimeString(); } catch (_) {}
    const entry = `${stamp} ${body}`;
    _logs.push(entry);
    if (_logs.length > 800) _logs.shift();
    _ship.push(entry);
    if (_ship.length > 1200) _ship.shift();
    if (DEBUG) { try { console.log('[blindMode]', entry); } catch (_) {} }
  }
  function getLogs() { return _logs.join('\n'); }

  // --- Server-side log shipping (for remote blind testers like Josh) ---
  // Allow-listed players' blind-mode activity is streamed to the backend
  // (blind:log event) so we can read their session in backend/logs/blind.jsonl
  // WITHOUT asking a blind, remote user to copy their browser console. Gated by
  // player id client-side (LOG_SHIP_PLAYERS) AND server-side (BLIND_LOG_PLAYERS
  // env, default 'josh'). Fire-and-forget: emitting to a backend without the
  // handler is a harmless no-op, so the client can ship safely before the
  // server side is deployed.
  const LOG_SHIP_PLAYERS = ['josh'];
  let _shipTimer = null;
  function _shipEnabled() {
    try {
      const me = state.deps?.state?.me;
      const id = String(me?.player_id || me?.nickname || '').toLowerCase();
      return !!id && LOG_SHIP_PLAYERS.includes(id);
    } catch (_) { return false; }
  }
  function _flushShip() {
    if (!_ship.length || !_shipEnabled()) return;
    const socket = state.deps?.socket;
    if (!socket || socket.connected === false) return;
    const batch = _ship.splice(0, 120);
    const me = state.deps?.state?.me || {};
    try {
      socket.emit('blind:log', { playerId: me.player_id || null, nickname: me.nickname || null, entries: batch });
    } catch (_) { _ship.unshift(...batch); }  // put them back; retry next tick
  }
  function startShipping() {
    if (_shipTimer) return;
    try { _shipTimer = setInterval(_flushShip, 2500); } catch (_) {}
    try { window.addEventListener('beforeunload', _flushShip); } catch (_) {}
  }

  // Log the environment once at module load — this alone usually explains a
  // dead microphone (no SR API, or a non-secure origin where Chrome blocks it).
  blog('module loaded', JSON.stringify({
    supportsTTS, supportsSR,
    secureContext: (typeof isSecureContext !== 'undefined') ? isSecureContext : 'unknown',
    proto: location.protocol,
    ua: navigator.userAgent,
  }));

  // ---------- Pronunciation overrides ----------
  // Written → phonetic spelling for names the TTS voice mispronounces,
  // applied as a word-boundary case-insensitive replace in speak().
  // SINGLE SOURCE OF TRUTH: this list is fetched from the backend on init
  // (GET /api/pronunciations), the SAME list the 11labs TTS uses — so a new
  // name is added in exactly one place (backend/src/util/pronunciations.js).
  // Starts empty; populated by the fetch in init(). If the fetch fails, names
  // just read literally (no crash).
  let NAME_PRONUNCIATIONS = [];
  // UI WORDS the browser speech engine mangles (not character names — those come
  // from /api/pronunciations). Applied the same way in speak(). e.g. some voices
  // read "spectate" as "speck-tit"; respell it phonetically.
  const WORD_FIXES = [
    ['spectate', 'speck tate'],
  ];

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
    // TTS speed multiplier. Lowered from 1.7 → 1.2: 1.7 was tuned for one
    // power user but reads the cards too fast for most blind players. Now
    // PERSISTED to localStorage and adjustable live with [ (slower) and
    // ] (faster), so anyone can dial in their own pace and it sticks.
    rate: 1.2,
    volume: 1.0,              // narration loudness (0.1..1) — adjustable live with - / = (Josh), PERSISTED
    pitch: 1.0,
    voice: null,              // chosen voice object once available
    queue: [],                // [{text, prio}, ...]
    speaking: false,
    shadow: [],               // utterances handed to the engine that haven't STARTED yet (watchdog replay list)
    lastAliveTs: 0,           // last time the engine proved it was talking (onstart/onboundary)
    listening: false,
    rec: null,                // active SpeechRecognition instance
    // True while a banter audio clip is playing on this client (either
    // 11labs base64 or a local sound-pool URL). Acts as a gate: non-
    // urgent TTS waits until the audio ends; urgent TTS cancels the
    // audio so the cues don't overlap. Updated by client.js via the
    // exposed notifyBanterStart/End hooks.
    banterAudio: null,        // current Audio element, or null
    pendingConfirm: null,     // { kind:'raise', amount, expiresAt }
    pendingSit: null,         // { idx, expiresAt } — empty seat armed by a number key; Return confirms
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
    // 'clear' — a rising C-E-G chime: the ROOM IS CLEARED, the end-of-room report is
    // starting (Josh: he had no audible cue a room ended, so he'd press keys and cut
    // the report off). Distinct from 'turn' (three flat 880 pulses).
    else if (kind === 'clear') { make(now, 0.12, 523); make(now + 0.13, 0.12, 659); make(now + 0.26, 0.16, 784); }
  }

  // ---------- TTS: 3-tier priority on the browser's NATIVE utterance queue ----------
  // ROOT-CAUSE NOTE: the previous design kept its OWN queue + a manual `state.speaking`
  // flag and advanced only when an utterance's `onend` fired. Browsers (Chrome
  // especially) fire `onend` unreliably — drop it under load, after a `cancel()`, or
  // after the ~15s auto-pause — so the manual flag would stick "true" and the queue
  // died. Only the `urgent` path (which calls `cancel()`) still spoke, which is exactly
  // the "blind support only talks on his turn" symptom. The fix is to NOT depend on
  // `onend` at all: hand each utterance straight to speechSynthesis, which advances
  // its OWN queue internally. We only call cancel() to interrupt (urgent), and we
  // resume() periodically to defeat the documented auto-pause. No manual flag to stick.
  const PRIO = { urgent: 3, event: 2, ambient: 1 };
  // ── Character-voice clip SERIALIZER. Two AI character voices must not talk over
  // EACH OTHER, so clips play one-at-a-time (queued here, emitted via a player
  // registered by client.js). They do NOT wait for the narrator — the screen reader
  // is the PRIORITY voice and always speaks immediately; while it talks, the playing
  // clip simply DUCKS to a low volume (see the ducking controller below) and keeps
  // going. (Josh, blind tester: a hard mute/stop chopped character lines into
  // word-salad, and a strict queue starved them entirely since narration is near-
  // constant in a fight — ducking is the thing that actually works.)
  const bus = {
    clipQueue: [],          // [{b64|url, mime, muffle, ts}] character-voice clips waiting
    player: null,           // (item, onEnded) => void — registered by client.js
    fallback: null,         // safety timer so a missing end-event can't stall the queue
    clipBusy() { return !!state.banterAudio; },   // a clip is currently playing
    registerPlayer(fn) { this.player = fn; },
    enqueueClip(item) {
      if (!item || !(item.b64 || item.url)) return;
      item.ts = Date.now();
      this.clipQueue.push(item);
      while (this.clipQueue.length > 3) this.clipQueue.shift();   // banter is disposable — keep it current
      this.drainClips();
    },
    drainClips() {
      if (!this.player) return;
      if (this.clipBusy()) return;          // one character voice at a time
      let next = null;
      while (this.clipQueue.length) {
        const c = this.clipQueue.shift();
        if (Date.now() - c.ts <= 6000) { next = c; break; }   // skip stale banter
      }
      if (!next) return;
      let advanced = false;
      const advance = () => {
        if (advanced) return; advanced = true;
        clearTimeout(this.fallback);
        state.banterAudio = null;           // clip finished — free the slot
        this.drainClips();                  // next clip (if any)
      };
      this.fallback = setTimeout(advance, 20000);   // hard safety: never stall on a missing end-event
      try { this.player(next, advance); } catch (_) { advance(); }
    },
  };
  function speak(text, prio = 'event', section = null) {
    if (!state.on || !supportsTTS || !text) return;
    text = String(text);
    // Drop the currency word entirely. Josh asked for the bare number
    // ("call fifty", not "call fifty gold") to keep the cadence quick —
    // the unit is always gold at this table, so it's dead weight on the
    // ear. Strips "gp" AND "gold" (the latter in case a line already
    // spelled it out), eating the space before it so "50 gp." → "50."
    // The trailing period (sentence beat) is preserved.
    text = text.replace(/\s*\bg(?:p|old)\b/gi, '');
    // Read a number/number ratio as "X of Y" instead of "X slash Y". Josh: the
    // voice spends real time on every "/" in HP totals (and they compound when
    // reading the whole party). "65/80" → "65 of 80". (A fractional CR like
    // "1/3" also becomes "1 of 3" — rare and still clear.)
    text = text.replace(/(\d+)\s*\/\s*(\d+)/g, '$1 of $2');
    // Pronunciation fixes — written names the TTS engine routinely
    // mangles get spelled phonetically here so the screen-reader
    // voice says them correctly. Add new pairs as they surface.
    // Word-boundary match keeps it from corrupting substrings.
    for (const [orig, phon] of NAME_PRONUNCIATIONS) {
      text = text.replace(new RegExp(`\\b${orig}\\b`, 'gi'), phon);
    }
    for (const [orig, phon] of WORD_FIXES) {
      text = text.replace(new RegExp(`\\b${orig}\\b`, 'gi'), phon);
    }
    // Lengthen the pause after a divine-oath clause (see OATH_RE above).
    text = text.replace(OATH_RE, '$1$2...');
    const p = PRIO[prio] ?? PRIO.event;
    // The screen reader is ALWAYS priority and speaks immediately — it never waits on
    // a character voice (that just DUCKS under it, see the ducking controller below).
    // Only policy here: ambient is pure background, dropped if the engine is already
    // busy; urgent interrupts the engine queue so a critical cue (your turn) lands at
    // once. We do NOT stop the playing character clip — it ducks and keeps going.
    if (p === PRIO.ambient && (TTS.speaking || TTS.pending)) return;
    if (p === PRIO.urgent) {
      // PREEMPT, don't DESTROY (Josh 2026-07-15: "it is CEASING to speak rather than
      // announce a loot roll" — and speech "getting caught and cutting off" elsewhere).
      // An urgent cue used to cancel the engine AND wipe the spool, so every queued-but-
      // unspoken report line (the loot drop, XP, level-ups…) was silently eaten. Now we
      // capture the unstarted lines FIRST, cancel, speak the urgent cue, then re-queue
      // the captured lines — the report resumes right where it left off. Only the line
      // that was mid-sentence is lost (it was interrupted; that's what urgent means).
      const resume = (state.spool || []).slice();   // spool = queued lines the engine hasn't STARTED (onstart drops them)
      try { TTS.cancel(); } catch (_) {}
      state.shadow.length = 0;   // engine queue is gone — drop everything shadowed
      if (state.spool) state.spool.length = 0;   // rebuilt below as the resume lines re-enter
      state.curSection = null;
      _engineSpeak(text, prio, section);
      for (const r of resume) _engineSpeak(r.text, r.prio, r.section);
      return;
    }
    _engineSpeak(text, prio, section);
  }
  // Hand an (already-substituted) line straight to the browser's NATIVE engine queue,
  // with the watchdog shadow bookkeeping. The engine serializes its own utterances;
  // any character clip playing alongside ducks under these rather than overlapping at
  // full volume. We never rely on `onend` (Chrome drops it), so a dropped end event
  // can't wedge narration.
  function _engineSpeak(text, prio, section = null) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = state.rate;
    u.volume = state.volume;
    u.pitch = state.pitch;
    if (state.voice) u.voice = state.voice;
    blog('speak', `[${prio}]`, text.length > 90 ? text.slice(0, 90) + '…' : text);
    if (prio === 'event') state.lastEventText = text;
    // WATCHDOG bookkeeping: shadow every utterance we hand the engine until it
    // actually STARTS, so a wedge (see below) can replay the last unspoken lines.
    const rec = { text, prio };
    state.shadow.push(rec);
    if (state.shadow.length > 6) state.shadow.shift();
    // SECTION SPOOL — a parallel ledger of every not-yet-started utterance, tagged
    // with its report section ('combat' / 'loot' / 'xp' / 'levelup'). stopSpeaking()
    // uses it to skip ONLY the section now reading and re-queue the rest (Josh's
    // segmented end-of-room silence). Rides onstart/onerror only — never onend.
    const spool = (state.spool = state.spool || []);
    const srec = { text, prio, section: section || null };
    spool.push(srec);
    if (spool.length > 60) spool.shift();
    const sdrop = () => { const j = spool.indexOf(srec); if (j > -1) spool.splice(j, 1); };
    const alive = () => { state.lastAliveTs = Date.now(); const i = state.shadow.indexOf(rec); if (i > -1) state.shadow.splice(i, 1); };
    u.onstart = () => { state.curSection = srec.section; sdrop(); alive(); };
    u.onboundary = () => { state.lastAliveTs = Date.now(); };   // fires per word — proof the engine is really talking
    u.onerror = () => { sdrop(); alive(); };   // errored utterances must not count as "pending forever"
    // Hand it straight to the engine's queue — it plays this after anything already
    // queued, and advances itself. We do NOT rely on onend, so a dropped onend can
    // never wedge narration.
    try { TTS.speak(u); } catch (_) {}
  }
  // Chrome silently PAUSES speechSynthesis after ~15s of sustained output; an
  // UNCONDITIONAL periodic resume() un-pauses it (a no-op when not paused). This is
  // the one documented engine workaround we still need; it does not depend on any
  // of our own state, so it can't desync.
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    setInterval(() => { try { window.speechSynthesis.resume(); } catch (_) {} }, 8000);
  }
  // Audio ducking was REMOVED (Josh, 2026-06-26): the audio-settings AI-voice slider
  // already lets him set a comfortable static level, so the screen reader doesn't need
  // to duck the character voices — they just play at their chosen volume, and his
  // narration is loud/clear via its own volume control (see setVolume). Simpler, and
  // no bobbing. (client.js still defines a harmless no-op _duckApply on each clip.)
  // ZOMBIE-ENGINE WATCHDOG. Chrome's speech engine can wedge for good when a
  // cancel() lands mid-utterance (it keeps claiming `speaking` with a dead queue —
  // this is what killed narration after leaving + re-entering the dungeon: every
  // 'event' line queued behind the corpse forever, and only 'urgent' lines — which
  // cancel() first — still spoke, i.e. "it only tells me my turn"). Every 3s: if the
  // engine CLAIMS it's busy but nothing has started/spoken a word in 8s, declare it
  // wedged — cancel() to clear the corpse and replay the last few unspoken lines.
  // resume() alone provably did NOT fix this; cancel() is the only cure.
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    setInterval(() => {
      if (!state.on) return;
      const eng = window.speechSynthesis;
      if (!(eng.speaking || eng.pending)) return;                  // idle — fine
      if (Date.now() - (state.lastAliveTs || 0) < 8000) return;    // words are flowing — fine
      blog('watchdog', 'speech engine wedged — resetting and replaying', state.shadow.length, 'line(s)');
      try { eng.cancel(); } catch (_) {}
      state.lastAliveTs = Date.now();                              // grace so we don't double-fire
      const replay = state.shadow.splice(0).slice(-3);             // newest 3 unspoken lines
      for (const it of replay) speak(it.text, it.prio === 'urgent' ? 'event' : it.prio);
    }, 3000);
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
    blog('pickVoice', state.voice ? `${state.voice.name} (${state.voice.lang}${state.voice.localService ? ', local' : ''})` : 'none', `of ${vs.length} voices`);
  }

  // ---------- Reading-speed control (persisted + live-adjustable) ----------
  // Clamped to the same 0.8–2.5 band the voice commands used. Persisted to
  // localStorage so a player's chosen pace survives reloads. `announce` reads
  // the new rate back so an adjustment is audible feedback even with no screen.
  function setRate(newRate, announce = true) {
    const r = Math.max(0.8, Math.min(2.5, Number(newRate) || state.rate));
    state.rate = Math.round(r * 100) / 100;
    try { localStorage.setItem('blindRate', String(state.rate)); } catch (_) {}
    blog('setRate', state.rate);
    if (announce) speak(`Reading speed ${state.rate.toFixed(2)}.`, 'urgent');
  }
  function nudgeRate(delta) { setRate(state.rate + delta); }
  // Narration LOUDNESS (0.1..1) — Josh asked to adjust the screen-reader voice volume
  // the same way as the rate (so he can balance it against Discord chat / game audio).
  // It IS adjustable: SpeechSynthesisUtterance.volume. Persisted, live via - and =.
  function setVolume(newVol, announce = true) {
    const v = Math.max(0.1, Math.min(1, Number(newVol)));
    if (!Number.isFinite(v)) return;
    state.volume = Math.round(v * 100) / 100;
    try { localStorage.setItem('blindVolume', String(state.volume)); } catch (_) {}
    blog('setVolume', state.volume);
    if (announce) speak(`Voice volume ${Math.round(state.volume * 100)} percent.`, 'urgent');
  }
  function nudgeVolume(delta) { setVolume(state.volume + delta); }

  // ---------- Mode toggle ----------
  function toggle() {
    if (!supportsTTS) {
      state.deps?.toast?.('Speech synthesis unavailable in this browser.', true);
      return;
    }
    state.on = !state.on;
    blog('toggle ->', state.on ? 'ON' : 'OFF');
    try { sessionStorage.setItem('blindMode', state.on ? '1' : '0'); } catch (_) {}
    updateChip();
    if (state.on) {
      // Declutter for VoiceOver: collapse the hand-rankings panel (its ten
      // static list items are pure noise to a screen reader — Josh asked).
      // It stays a normal <details>, so it can be re-opened any time.
      try { document.querySelector('.help-panel__ranks')?.removeAttribute('open'); } catch (_) {}
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
        u.rate = state.rate; u.volume = state.volume; if (state.voice) u.voice = state.voice;
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
    // POKER STAYS AT THE TABLE. While you're down in the dungeon the felt keeps
    // running (bots + other humans), but its TTS narration must NOT bleed into
    // the dungeon (Josh: "poker is still announcing in the dungeon"). Keep every
    // diff tracker synced to the live table so returning to your seat doesn't
    // dump a backlog of "new hand / flop / X wins" — just stay silent here.
    // Dungeon combat narration rides a separate path (onDungeonState), so this
    // guard never silences the dungeon itself. (Banter/SFX audio is already
    // muffled "through the floor" in client.js; this covers the spoken lines.)
    if (typeof document !== 'undefined' && document.body && document.body.dataset.screen === 'dungeon') {
      state.prevState = st;
      const h = st.hand;
      state.prevBoardLen = (h && h.board ? h.board.length : 0);
      state.prevActor = currentActorId(st);
      if (h && h.state === 'COMPLETE' && h.winners && h.winners.length) {
        state.prevWinners = h.winners.map(w => `${w.playerId}:${w.amount}`).join('|');
      }
      return;
    }
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
          line += ` Hold ${pttLabel()} and say fold, call, or raise; press H to hear your hand again; C for your cards, B for the board, P for the pot, M for your cash, N for your bet this hand, or a seat number one to nine to hear that seat; S to stop talking; left and right bracket slow down or speed up this voice.`;
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
    // In the dungeon, the poker play-by-play stays silent (Josh: "poker is still
    // announcing in the dungeon"). table:chat is poker-only — dungeon combat is
    // narrated via onDungeonState — so suppressing it here never mutes the
    // dungeon. Banter/SFX audio is muffled "through the floor" in client.js.
    if (typeof document !== 'undefined' && document.body && document.body.dataset.screen === 'dungeon') return;
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
    blog('startListening called', JSON.stringify({ on: state.on, supportsSR, listening: state.listening }));
    if (!state.on) { blog('startListening abort: mode off'); return; }
    if (!supportsSR) { blog('startListening abort: NO speech-recognition API in this browser'); return; }
    if (state.listening) { blog('startListening abort: already listening'); return; }
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
        if (!alts.length) { blog('SR onresult: no transcript'); return; }
        blog('SR onresult', JSON.stringify(alts));
        const chosen = alts.find(a => COMMAND_HINT.test(a.toLowerCase())) || alts[0];
        processCommand(chosen);
      };
      // Full lifecycle logging — these handlers are how we tell apart "mic
      // never opened" (no onstart), "mic opened but no audio" (no
      // onaudiostart), "permission denied" (onerror not-allowed), etc.
      rec.onstart       = () => blog('SR onstart (recognition session began)');
      rec.onaudiostart  = () => blog('SR onaudiostart (microphone capturing)');
      rec.onspeechstart = () => blog('SR onspeechstart (speech detected)');
      rec.onspeechend   = () => blog('SR onspeechend');
      rec.onnomatch     = () => blog('SR onnomatch (heard speech, no confident match)');
      rec.onerror = (e) => {
        // Log EVERY error code — 'not-allowed'/'service-not-allowed' = mic
        // permission blocked; 'audio-capture' = no microphone; 'network' =
        // STT backend unreachable; 'no-speech'/'aborted' are benign timeouts.
        blog('SR onerror', JSON.stringify({ error: e.error, message: e.message || '' }));
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        earcon('error');
      };
      rec.onend = () => { blog('SR onend'); state.listening = false; state.rec = null; };
      rec.start();
      state.listening = true;
      state.rec = rec;
      earcon('open');
      blog('SR rec.start() issued ok');
    } catch (err) {
      blog('startListening EXCEPTION', String(err && err.message || err));
    }
  }
  function stopListening() {
    blog('stopListening called', JSON.stringify({ listening: state.listening }));
    if (!state.listening || !state.rec) return;
    try { state.rec.stop(); } catch (err) { blog('stopListening EXCEPTION', String(err && err.message || err)); }
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
    blog('processCommand', JSON.stringify(raw), `screen=${document.body.dataset.screen || '?'}`);
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
    if (/^(faster|speed up)$/.test(raw)) { nudgeRate(+0.2); return; }
    if (/^(slower|slow down)$/.test(raw)) { nudgeRate(-0.2); return; }
    // Rebind the push-to-talk key by voice.
    if (/^(change|set|rebind)\s+(my\s+)?(push[\s-]?to[\s-]?talk|talk|mic|ptt)(\s+key)?$/.test(raw)) { beginRebind(); return; }

    // Seating — "sit", "sit down", "take a seat", or "sit seat 3".
    const sitSeat = raw.match(/^(?:sit|take)\s+(?:in\s+)?seat\s+(\d+)$/);
    if (sitSeat) { sit(parseInt(sitSeat[1], 10) - 1); return; }
    if (/^(sit|sit down|take a seat|sit me down)$/.test(raw)) { sit(); return; }

    // Read-only queries
    if (/^repeat$/.test(raw)) { repeatLast(); return; }
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
    blog('dispatchAction', JSON.stringify({ kind, amount: amount ?? null, hasSocket: !!socket }));
    if (!socket) { earcon('error'); return; }
    const payload = { action: kind };
    if (kind === 'raise' && Number.isFinite(amount)) payload.amount = amount;
    socket.emit('table:action', payload, (resp) => {
      blog('dispatchAction ack', JSON.stringify({ ok: !!resp?.ok, error: resp?.error || null }));
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
    state.pendingSit = null;
    const hand = state.deps?.state?.table?.hand;
    const pot = hand?.potTotal ?? 0;
    speak(`Pot ${Number(pot).toLocaleString()}.`, 'urgent');
  }
  function announceStack() {
    state.pendingSit = null;
    const mePid = state.deps?.state?.me?.player_id;
    const hand  = state.deps?.state?.table?.hand;
    const inHand = hand?.players?.find(p => p.playerId === mePid)?.stack;
    if (Number.isFinite(inHand)) { speak(`Cash ${Number(inHand).toLocaleString()}.`, 'urgent'); return; }
    const seat = state.deps?.state?.table?.seats?.find(s => s.playerId === mePid);
    const chips = Number(seat?.chips || state.deps?.state?.me?.chips || 0);
    speak(`Cash ${chips.toLocaleString()}.`, 'urgent');
  }
  /** How much I've put into THIS hand so far, plus what it'd cost to call (the N
   *  key). "Current bet invested" — distinct from total cash (the M key). */
  function announceMyBet() {
    state.pendingSit = null;
    const mePid = state.deps?.state?.me?.player_id;
    const hand  = state.deps?.state?.table?.hand;
    const p = hand?.players?.find(pp => pp.playerId === mePid);
    if (!p) { speak('You are not in this hand.', 'urgent'); return; }
    const invested = Number(p.invested || 0);
    const toCall = Math.max(0, Number(hand.currentBet || 0) - invested);
    let line = `You've bet ${invested.toLocaleString()}.`;
    line += toCall > 0 ? ` To call ${toCall.toLocaleString()}.` : ' You can check.';
    speak(line, 'urgent');
  }
  function announceBoard() {
    state.pendingSit = null;
    const board = state.deps?.state?.table?.hand?.board || [];
    if (!board.length) { speak('Preflop. No community cards yet.', 'urgent'); return; }
    speak(`Board: ${cardListWords(board)}.`, 'urgent');
  }
  /** Read ONLY my hole cards (the C key) — "what am I holding?" without the
   *  board. (H reads hole + board; this is the terser, card-focused query.) */
  function readMyCards() {
    if (!state.on) return;
    state.pendingSit = null;
    const hole = state.deps?.state?.myHole;
    if (hole && hole.length) speak(`Your cards: ${cardListWords(hole)}.`, 'urgent');
    else speak('You have no cards right now.', 'urgent');
  }
  /** CARD READER (the 0 mode, client.js holds the toggle): speak ONLY the card
   *  at that slot — the player already knows which key they pressed, so no slot
   *  label (Josh). The slot meanings are taught in HELP mode instead (client.js).
   *  1, 2 = pocket; 4, 5, 6 = flop; 7 = turn; 8 = river. */
  function readCardSlot(n) {
    if (!state.on) return;
    state.pendingSit = null;
    const hole  = state.deps?.state?.myHole || [];
    const board = state.deps?.state?.table?.hand?.board || [];
    const SLOT = { 1: hole[0], 2: hole[1], 4: board[0], 5: board[1], 6: board[2], 7: board[3], 8: board[4] };
    if (!(n in SLOT)) { speak('No card on that key. 1 and 2 pocket, 4 5 6 flop, 7 turn, 8 river.', 'urgent'); return; }
    const card = SLOT[n];
    speak(card ? `${cardWords(card)}.` : 'Not dealt yet.', 'urgent');
  }
  /** Stop talking NOW (the S key). Cancels the in-flight utterance, empties the
   *  queue, and cuts any character-voice/banter clip — so a blind player can
   *  silence a long readout the instant they've heard enough. A short blip
   *  confirms the key registered. */
  function stopSpeaking() {
    if (!state.on) return;
    // SEGMENTED SILENCE (Josh, 2026-07-03): during a tagged report the stop key
    // skips ONLY the section now reading — post-turn combat, then loot, then XP,
    // then level-ups each silence separately, so one press never nukes the whole
    // end-of-room report. Outside tagged reports (no current section) it behaves
    // as before: silence everything.
    const spool = state.spool || [];
    const cur = state.curSection || (spool[0] && spool[0].section) || null;
    // FIX (Josh 2026-07-08 — "S kills a whole slew, not one strand at a time"): when skipping a
    // TAGGED section, keep every OTHER line INCLUDING untagged ones (was `r.section &&`, which
    // silently nuked untagged lines like the end-of-room XP/gold summary that trailed the combat
    // line). When the current line is UNTAGGED (no section), skip only IT and keep the rest of the
    // spool — so S steps ONE report at a time instead of silencing the whole tail.
    const keep = cur ? spool.filter(r => r.section !== cur) : spool.slice();
    blog('stopSpeaking', cur ? `(skip section ${cur} — ${keep.length} lines resume)` : `(skip one line — ${keep.length} resume)`);
    try { TTS.cancel(); } catch (_) {}
    state.queue.length = 0;
    state.speaking = false;
    spool.length = 0;
    state.curSection = null;
    if (state.banterAudio) {
      try { state.banterAudio.pause(); state.banterAudio.currentTime = 0; } catch (_) {}
      state.banterAudio = null;
    }
    earcon('close');
    for (const r of keep) _engineSpeak(r.text, r.prio, r.section);   // the REST of the report reads on
  }
  /** Repeat the last report (Josh 2026-07-09: re-hear a level-up or line you moved past
   *  too fast). Re-speaks the last EVENT-priority line (`state.lastEventText`) — combat
   *  results, level-ups, and end-of-room lines are all events; transient 'urgent' prompts
   *  like "Your turn" don't overwrite it, so this brings back the last real report. Bound
   *  to the A key in client.js (moved from ' per Josh 2026-07-12) and the "repeat" voice command. */
  function repeatLast() {
    if (!state.on) return;
    if (state.lastEventText) speak(state.lastEventText, 'urgent');
    else speak('Nothing to repeat yet.', 'urgent');
  }
  /** Read the FOE hot-list on demand (Josh 2026-07-13, F key): the quick enemy snapshot
   *  (name, HP %, flying, party-landed debuffs) — the SAME as the turn prompt — so a blind
   *  player can re-hear who to target without opening the full E-inspector. `d` is the
   *  current dungeon state (client passes state.dungeon). */
  function readEnemies(d) {
    if (!state.on) return;
    speak(d ? _dunEnemyPhrase(d) : 'No enemies.', 'urgent');
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
    state.pendingSit = null;
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

  /** Number keys 1–9 at the table. Occupied seat → speak who's there. Empty
   *  seat → ARM it (state.pendingSit) and say "Sit N"; the player then presses
   *  Return (their affirmative key) to actually sit. We arm-then-confirm rather
   *  than focus the DOM seat button because the table re-renders constantly
   *  (every opponent action), which would drop real focus before they confirm.
   *  No visual cue needed — the spoken "Sit N" IS the selection. */
  function announceSeat(n) {
    if (!state.on) return;
    state.pendingSit = null;
    const seats = state.deps?.state?.table?.seats || [];
    const idx = n - 1;
    const seat = seats.find(s => s.index === idx) || seats[idx];
    if (!seat) { speak(`No seat ${n}.`, 'urgent'); return; }
    if (seat.occupied && seat.playerId) {
      const mePid = state.deps?.state?.me?.player_id;
      const you = seat.playerId === mePid ? ', you' : '';
      speak(`Seat ${n}: ${seat.nickname || 'someone'}${you}.`, 'urgent');
      return;
    }
    // Empty seat → arm it; Return confirms (see confirmPendingSit).
    state.pendingSit = { idx, expiresAt: Date.now() + 20000 };
    speak(`Sit ${n}. Press return to take it.`, 'urgent');
  }

  /** Confirm an armed empty seat (Return key, wired in client.js). Returns true
   *  if it handled a pending sit, so the caller can swallow the keypress. Routes
   *  through sit(), which re-validates the seat is still open. */
  function confirmPendingSit() {
    const p = state.pendingSit;
    if (!p) return false;
    state.pendingSit = null;
    if (Date.now() >= p.expiresAt) { speak('Seat selection expired.', 'urgent'); return true; }
    sit(p.idx);
    return true;
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
    // Restore the saved reading speed (localStorage). Falls back to the
    // gentler default (1.2) when unset.
    try {
      const savedRate = parseFloat(localStorage.getItem('blindRate'));
      if (Number.isFinite(savedRate)) state.rate = Math.max(0.8, Math.min(2.5, savedRate));
      const savedVol = parseFloat(localStorage.getItem('blindVolume'));
      if (Number.isFinite(savedVol)) state.volume = Math.max(0.1, Math.min(1, savedVol));
    } catch (_) {}
    // Restore mode from sessionStorage
    try {
      const stored = sessionStorage.getItem('blindMode');
      if (stored === '1' && supportsTTS) {
        // Late-restore: announce silently (no earcon on cold start to
        // avoid surprising sighted users sharing the tab).
        state.on = true;
        updateChip();
        try { document.querySelector('.help-panel__ranks')?.removeAttribute('open'); } catch (_) {}   // same VoiceOver declutter as toggle-on
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
    blog('init done', JSON.stringify({
      supportsTTS, supportsSR, rate: state.rate, pttCode: state.pttCode,
      restoredOn: state.on,
    }));
    startShipping();
    return { supportsTTS, supportsSR };
  }

  // Called by client.js (and the bus's clip player) when a character-voice clip
  // starts. `state.banterAudio` tracks the CURRENT clip so (a) the serializer plays
  // one at a time and (b) the ducking controller can lower its volume while the screen
  // reader talks. Cleared on end/error/pause so a clip whose events never fire can't
  // wedge anything (the bus's 20s fallback also frees the slot).
  function notifyBanterStart(audioEl) {
    if (!audioEl) return;
    state.banterAudio = audioEl;
    const clear = () => { if (state.banterAudio === audioEl) state.banterAudio = null; };
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
  // CR string → number ('1/2' → 0.5) so enemy lists sort deadliest-first.
  function _crVal(cr) { const s = String(cr || 0); if (s.includes('/')) { const [a, b] = s.split('/'); return (+a || 0) / (+b || 1); } return +s || 0; }
  function _dunEnemyPhrase(d) {
    // DEADLIEST FIRST — the SAME order (and therefore the SAME numbers) as the
    // attack target picker and the E-inspector, so "2" always means the same foe
    // no matter which list you heard it in.
    // TARGETABLE foes only (v3.37.64, Josh): ally summons ride in d.enemies (flagged
    // `summoned`) and a big devil sorts first by CR — the quick list led with his OWN
    // devil. Shrouded (darkness) foes are equally untargetable; counted in a tail line
    // instead so he still knows they're in the room.
    const alive = (d.enemies || []).filter(e => e.alive && !e.summoned && !e.darkened).sort((a, b) => _crVal(b.cr) - _crVal(a.cr));
    const darkN = (d.enemies || []).filter(e => e.alive && !e.summoned && e.darkened).length;
    const darkTail = darkN ? ` Plus ${darkN} shrouded in darkness — untargetable.` : '';
    if (!alive.length) return darkN ? `No targetable enemies.${darkTail}` : 'No enemies.';
    // QUICK TARGET LIST (Josh 2026-07-11, revised): name, HP as a PERCENT, flying only
    // if flying, and any DEBUFFS the party has landed (prone / grappled / held / sickened
    // …) — the snapshot he needs to PICK a target fast ("Elite Vampire, 80%, prone").
    // Percent reads quicker than "105 of 160 HP", and the debuffs tell him who's easy to
    // pile on. Full HP / CR / DR still live in the E-inspector (he opens it for deep info).
    const fly = (e) => e.flying ? ', flying' : '';
    const hp = (e) => `${Math.round(100 * Math.max(0, e.hp | 0) / (e.maxHp || 1))}%`;
    const debs = (e) => { const ds = (e.conditions || []).map(c => c.label).filter(Boolean); return ds.length ? ', ' + ds.join(', ') : ''; };
    if (alive.length === 1) return `Enemy: ${alive[0].name}, ${hp(alive[0])}${fly(alive[0])}${debs(alive[0])}.${darkTail}`;
    return `${alive.length} enemies, deadliest first. ` + alive.map((e, i) => `${i + 1}: ${e.name}, ${hp(e)}${fly(e)}${debs(e)}`).join('. ') + '.' + darkTail;
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
      else { const ne = (st.enemies || []).filter(e => e.alive && !e.summoned).length; speak(`Room ${st.depth}. ${ne} ${ne === 1 ? 'enemy' : 'enemies'}. Press E to inspect them.`, 'event'); }
    }
    // New combat-log lines (results) — speak EVERY fresh line, oldest first,
    // stripped of emoji. (The old `.slice(-2)` kept only the newest two, so a
    // multi-line turn — cleave hit + Haste blur + Haste hit — dropped the actual
    // attack result and Josh heard only his bonus swing: "I can't attack".)
    // Cap a reconnect/rejoin backlog so the narrator can't flood for a minute.
    if (Array.isArray(st.log) && st.log.length) {
      const fresh = st.log.filter(e => e.t > _dun.logT);
      if (fresh.length) {
        _dun.logT = Math.max(_dun.logT, ...st.log.map(e => e.t));
        // Skip VOICED banter — the 11labs character voice already says it out loud.
        // Each line carries its report SECTION (server-stamped `phase`) so the stop
        // key can skip section-by-section (Josh's segmented silence).
        const said = (t, ph) => { if (t) speak(t, 'event', ph || null); };
        // BIG-ROOM CONDENSE (Josh): in crowded fights the per-enemy flavor floods the
        // queue and his allies' actions never finish reading before his turn. So in a
        // big room, speak EVERY party/ally line + anything that happened to HIM in full,
        // and collapse the rest of the enemy actions into a single tally. (Small rooms
        // and non-big fights keep the full play-by-play — the flavor he likes.)
        const enemyCount = (st.enemies || []).filter(e => e.alive && !e.summoned).length;   // ally summons don't make a room "big"
        const meM = (st.party || []).find(m => m.playerId === meId) || {};
        const myNick = String(meM.trueNick || meM.nickname || '').toLowerCase();
        const live = fresh.filter(e => !e.voiced);
        if (enemyCount >= 6 && live.length > 6) {
          const isMine = (e) => e.side !== 'enemy' || (myNick && _stripGlyphs(e.text).toLowerCase().includes(myNick));
          const mine = live.filter(isMine);
          const enemyTally = live.length - mine.length;          // collapsed enemy actions
          const show = mine.length > 8 ? mine.slice(-8) : mine;   // cap a reconnect flood of ally lines too
          if (show.length < mine.length) said(`Skipping ${mine.length - show.length} earlier ally lines.`, 'combat');
          for (const e of show) said(_stripGlyphs(e.text), e.phase || 'combat');
          if (enemyTally) said(`Plus ${enemyTally} more enemy action${enemyTally > 1 ? 's' : ''} — press E to inspect the foes.`, 'combat');
        } else {
          // COLLAPSE CC "idle" NO-OP enemy lines into ONE count (Josh 2026-07-09): a
          // Fascinate/Sleep on 3 foes made the narrator read out every entranced foe BY
          // NAME every round ("Goblin A stands fascinated — does nothing", ×3, each turn).
          // He wants it like a channel/AoE report: how MANY stand idle, not WHO. Matches
          // any pure no-op skip — fascinated / asleep / held / paralyzed / nauseated /
          // off-balance losing its turn. (A dominated foe SAVAGING an ally is a real
          // action, has no "does nothing", and is still spoken in full.)
          const isIdleNoop = (e) => e.side === 'enemy' && /does nothing|loses its turn|struggles in vain/i.test(String(e.text || ''));
          const active = live.filter(e => !isIdleNoop(e));
          const idleN = live.length - active.length;
          const toSay = active.length > 8 ? active.slice(-8) : active;
          if (toSay.length < active.length) said(`Skipping ${active.length - toSay.length} earlier lines.`, toSay[0] && toSay[0].phase);
          for (const e of toSay) said(_stripGlyphs(e.text), e.phase || (st.status === 'combat' ? 'combat' : null));
          if (idleN) said(`${idleN} foe${idleN === 1 ? '' : 's'} stand idle — entranced or held — and do nothing.`, 'combat');
        }
      }
    }
    // Turn changes.
    const turnKey = st.turn ? `${st.turn.kind}:${st.turn.id}:${st.round}` : `${st.status}`;
    if (turnKey !== _dun.turnKey) {
      _dun.turnKey = turnKey;
      if (st.status === 'combat' && st.turn && st.turn.kind === 'party' && st.turn.id === meId) {
        const me = (st.party||[]).find(m => m.playerId === meId) || {};
        earcon('turn');   // immediate audible cue (three pulses) so he knows his turn is up…
        // …but the SPOKEN prompt is 'event', NOT 'urgent' — urgent calls TTS.cancel()
        // and WIPES the queued foe-action lines, so Josh never heard what the foes
        // (incl. DOMINATED ones savaging their allies) did before his turn. 'event'
        // queues it AFTER those reports finish. Prompt + terse enemy list (name, HP,
        // flying) so he can numpad-target; no spell enumeration (he uses ?).
        speak('Your turn. ' + _dunEnemyPhrase(st), 'event');
      } else if (st.status === 'exploring' && _dun.status === 'combat') {
        earcon('clear');   // audible "room cleared" cue so a blind player knows the end-of-room report is coming (Josh)
        // Only give the "open the next door / bail" prompt NOW if there's no loot to
        // settle. If a loot roll is dropping, the prompt is deferred until the roll
        // resolves (see the loot block below) so it never splits the loot sequence (Josh).
        if (!st.lootRoll) speak('Room clear. Open the next door, or bail with your gold.', 'event');
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
      const hadLoot = !!_dun.lootKey;   // a roll was in progress and just resolved
      _dun.lootKey = lrKey;
      if (!lr && hadLoot && st.status === 'exploring') {
        // The loot roll just SETTLED — give the deferred "what next" prompt now, so it
        // lands AFTER the whole loot result instead of splitting it (Josh).
        speak('Loot settled. Open the next door, or bail with your gold.', 'event', 'loot');
      } else if (lr && (lr.eligible || []).includes(meId) && (lr.decided || {})[meId] === undefined) {
        // EVENT, not urgent — an urgent prompt cancelled the queued XP/level-up report
        // (Josh: "level-up got cut off by the loot roll"). Queued, it speaks in order
        // after the report; the 35s roll window leaves ample time to press R/P.
        speak(`Loot drop: a plus ${lr.tier} ${lr.label}. Press R to roll a d20 for it, or P to pass.`, 'event', 'loot');
      }
    }
  }

  // Voice command set while on the dungeon screen. Returns true if handled.
  function handleDungeonCommand(raw) {
    const d = state.deps?.state?.dungeon;
    const socket = state.deps?.socket;
    if (!d || !socket) return false;
    // Same TARGETABLE filter AND the same deadliest-first sort (and therefore the same
    // numbers) as _dunEnemyPhrase and the E-inspector — "attack two" must mean the same
    // foe everywhere (v3.37.64; this list was never sorted before, so a spoken "attack
    // two" could silently hit a different foe than the "2" he'd just heard).
    const alive = (d.enemies || []).filter(e => e.alive && !e.summoned && !e.darkened).sort((a, b) => _crVal(b.cr) - _crVal(a.cr));
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
    // SpeechBus: client.js registers its clip player + enqueues every character
    // voice here so narration and voices share one turnstile (no overlap).
    enqueueClip: (item) => bus.enqueueClip(item),
    registerPlayer: (fn) => bus.registerPlayer(fn),
    // Turn-controls + seating helpers (bound to keys in client.js)
    readHand, sit,
    // Explore hotkeys (C/B/P + seat numbers 1–9) and the Return-to-sit confirm.
    readMyCards, announceBoard, announcePot, announceSeat, confirmPendingSit,
    // Card reader mode (0 toggles in client.js; numbers read single cards).
    readCardSlot,
    // Money shortcuts: M = total cash, N = bet invested this hand.
    announceStack, announceMyBet,
    // Stop/silence the current announcement (the S key).
    stopSpeaking,
    // Repeat the last report (the A key + the "repeat" voice command).
    repeatLast,
    // Read the foe hot-list on demand (the F key).
    readEnemies,
    // Configurable push-to-talk binding
    getPttCode, isRebinding, beginRebind, consumeRebind, pttLabel,
    // Reading-speed control (bound to [ and ] in client.js) + diagnostics.
    setRate, nudgeRate, setVolume, nudgeVolume, getLogs, log: blog,
  };
})();
