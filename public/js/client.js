/* Folken Poker — client v0.4 (full hand UI).
   Renders the hand state machine: hole cards, community board, pot,
   current-actor highlight, action bar, showdown reveal. */
(() => {
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const PLAYER_KEY = 'folken-poker.playerId';
  const ALL_AVATARS = ['fox','owl','raccoon','knight','wizard','robot','cat','bear','frog','lion','wolf','dragon'];

  const state = {
    me: null,
    roster: [],
    table: null,            // { id, seats:[...], hand:{...} | null, ... }
    defaultStack: 5000,
    myHole: null,           // [card, card] for me (private)
    myHoleHandStartedAt: null,
    pendingPlayerId: null,
    pendingAvatar: null,
    winnerBannerTimer: null,
    /** Player avatar gallery — lazy-loaded from /tokens/manifest.json on
     *  first roster pick. Array of { id, name, art }. */
    tokens: null,
    /** User's drag offset for the action panel — persisted per tab in
     *  sessionStorage so it survives refresh/re-deal within the session.
     *  Null = use the CSS default placement (centered under/over seat). */
    actpanelOffset: null,
    /** Which collapsible section inside the action panel is open right
     *  now: 'bank' | 'leaderboard' | null. */
    actpanelSection: null,
  };

  // (Initial restore happens lazily via readActpanelOffset on first apply.)

  const ACTPANEL_OFFSET_KEY = 'folken-poker.actpanelOffset';

  function saveActpanelOffset() {
    try {
      if (state.actpanelOffset) {
        sessionStorage.setItem(ACTPANEL_OFFSET_KEY, JSON.stringify(state.actpanelOffset));
      } else {
        sessionStorage.removeItem(ACTPANEL_OFFSET_KEY);
      }
    } catch (_) { /* quota? ignore */ }
  }

  /** Read the current offset. sessionStorage is the source of truth; the
   *  in-memory state.actpanelOffset is a cache. If they diverge (a render
   *  fires before init reseed completes, for example) we fall back to
   *  sessionStorage and refresh the cache. */
  function readActpanelOffset() {
    if (state.actpanelOffset) return state.actpanelOffset;
    try {
      const raw = sessionStorage.getItem(ACTPANEL_OFFSET_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!Number.isFinite(o?.dx) || !Number.isFinite(o?.dy)) return null;
      state.actpanelOffset = o;
      return o;
    } catch (_) { return null; }
  }

  /** Apply the saved offset to whatever .actpanel exists in the current DOM. */
  function applyActpanelOffset() {
    const panel = document.querySelector('[data-actpanel]');
    if (!panel) return;
    const o = readActpanelOffset();
    if (o) {
      panel.style.setProperty('--drag-x', o.dx + 'px');
      panel.style.setProperty('--drag-y', o.dy + 'px');
    } else {
      panel.style.removeProperty('--drag-x');
      panel.style.removeProperty('--drag-y');
    }
  }

  // ===== Mobile detection =====
  // Tags <body> with `is-mobile` when the viewport is phone-sized OR
  // the device only has touch input (and the window is moderately
  // small). CSS keys major layout shifts off `.is-mobile` so we can
  // tweak responsiveness in one place. Re-evaluated on resize /
  // orientation change.
  function detectMobile() {
    const narrow = window.matchMedia('(max-width: 720px)').matches;
    const touchOnly = (window.matchMedia('(pointer: coarse)').matches
                       && !window.matchMedia('(pointer: fine)').matches);
    return narrow || (touchOnly && window.innerWidth < 900);
  }
  function syncMobileClass() {
    document.body.classList.toggle('is-mobile', detectMobile());
  }
  syncMobileClass();
  window.addEventListener('resize', syncMobileClass);
  window.addEventListener('orientationchange', syncMobileClass);

  // ===== Card sound effects =====
  // Two pools:
  //   SHUFFLE_POOL — plays once when a NEW hand begins (between rounds).
  //   DEAL_POOL    — plays each time the community board grows (flop,
  //                  turn, river — flop is the loudest event).
  // Random choice within pool gives audible variety. Each play creates
  // a fresh Audio so overlapping events don't cut each other off.
  // Mute toggle persists per tab in sessionStorage.
  const SHUFFLE_POOL = ['/audio/shuffle_01.mp3', '/audio/shuffle_03.mp3'];
  const DEAL_POOL    = ['/audio/shuffle_02_deal.mp3', '/audio/shuffle_04_deal_short.mp3', '/audio/shuffle_05_deal_again.mp3'];
  // Solo chime — only this client plays it, only when state.me becomes
  // the current actor. Everyone else is silent for that event.
  const YOUR_TURN_POOL = ['/audio/your-turn.mp3'];
  // Soft tick — plays for EVERYONE every time the actor advances to
  // the next player (bot or human). Subtler than the SHUFFLE / DEAL
  // hits so it doesn't fatigue across long hands.
  const TURN_TICK_POOL = ['/audio/card_slip_once.mp3'];
  // Single-card "flick / pitch" SFX — one plays per card during the
  // dealer-pitch animation, fired as the card LEAVES the dealer's hand.
  // Cut from the real deal recording (shuffle_05_deal_again) with ffmpeg —
  // six individual card hits, level-matched, so the pitch matches the
  // actual cards and the rapid stagger doesn't sound looped.
  const DEAL_CARD_POOL = [
    '/audio/deal_pitch_01.mp3', '/audio/deal_pitch_02.mp3', '/audio/deal_pitch_03.mp3',
    '/audio/deal_pitch_04.mp3', '/audio/deal_pitch_05.mp3', '/audio/deal_pitch_06.mp3',
  ];
  // Default volumes — overridden per-player by loadAudioSettings().
  // _cardVolume drives all card SFX (shuffle/deal/your-turn/tick).
  // _voiceVolume drives the 11labs MP3 playback (playBase64Mp3).
  let _cardVolume  = 0.45;
  let _voiceVolume = 0.85;
  // Audio prefs are PER-PLAYER (keyed by player_id in localStorage)
  // so they survive refreshes and tab swaps for as long as the same
  // player is sitting at this browser, but reset for a new player.
  // Defaults: card sounds ON, AI character voices OFF. The "off"
  // default for voice is deliberate — banter chat still shows but
  // the room stays quiet unless the player opts in via the audio menu.
  let _audioMuted = false;          // false = sounds ON
  let _bannerVoiceEnabled = false;  // false = AI voices OFF
  // Combat-gag SFX — three INDEPENDENT on/off switches so a player can
  // silence farts and/or swords without touching the others. All default
  // ON for a new player; persisted per-player like the rest.
  // Combat sounds — ONE channel now (sword + lightning + fart + dungeon),
  // with its own on/off + volume, mirroring the card-sound / voice channels.
  let _combatSoundEnabled = true;
  let _combatVolume       = 0.6;
  // 🃏 Card-deal animation — cards pitched from the dealer to each seat at
  // the start of a hand. Cosmetic; default ON, persisted per-player.
  let _dealAnimEnabled       = true;
  // True while this client is down in the dungeon side-game — poker SFX play
  // muffled (0.3×) as if heard through the floor.
  let _inDungeon = false;

  function audioSettingsKey(field) {
    const pid = state.me?.player_id;
    return pid ? `audio.${field}.${pid}` : null;
  }
  function loadAudioSettings() {
    const km = audioSettingsKey('muted');
    const kv = audioSettingsKey('bannerVoice');
    const kcv = audioSettingsKey('cardVol');
    const kvv = audioSettingsKey('voiceVol');
    // No state.me yet? Use defaults (don't read the unscoped keys).
    if (km) {
      const raw = localStorage.getItem(km);
      _audioMuted = raw === '1';   // missing → false (sounds on)
    } else _audioMuted = false;
    if (kv) {
      const raw = localStorage.getItem(kv);
      _bannerVoiceEnabled = raw === '1'; // missing → false (voices off)
    } else _bannerVoiceEnabled = false;
    // Volumes stored as integer percent 0..100; convert to 0..1 for
    // <audio>.volume. Missing → defaults defined at the top of the
    // SFX block so a brand-new player still gets sensible levels.
    if (kcv) {
      const raw = parseInt(localStorage.getItem(kcv), 10);
      _cardVolume = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) / 100 : 0.45;
    } else _cardVolume = 0.45;
    if (kvv) {
      const raw = parseInt(localStorage.getItem(kvv), 10);
      _voiceVolume = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) / 100 : 0.85;
    } else _voiceVolume = 0.85;
    // Combat toggles — stored as '1'/'0'. Anything other than the explicit
    // '0' (including a missing key for a brand-new player) means ON.
    const kce = audioSettingsKey('combatEnabled');
    _combatSoundEnabled = kce ? localStorage.getItem(kce) !== '0' : true;
    const kcvv = audioSettingsKey('combatVol');
    if (kcvv) { const raw = parseInt(localStorage.getItem(kcvv), 10); _combatVolume = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) / 100 : 0.6; }
    else _combatVolume = 0.6;
    const kda = audioSettingsKey('dealAnim');
    _dealAnimEnabled       = kda ? localStorage.getItem(kda) !== '0' : true;
    applyMuteUI();
    // After load, republish to server so a fresh reconnect / new
    // player login carries the right preference into the listener
    // count. (Server defaults to false on every connect.)
    pushVoicePrefToServer();
  }
  function saveAudioSettings() {
    const km = audioSettingsKey('muted');
    const kv = audioSettingsKey('bannerVoice');
    const kcv = audioSettingsKey('cardVol');
    const kvv = audioSettingsKey('voiceVol');
    if (km) localStorage.setItem(km, _audioMuted ? '1' : '0');
    if (kv) localStorage.setItem(kv, _bannerVoiceEnabled ? '1' : '0');
    if (kcv) localStorage.setItem(kcv, String(Math.round(_cardVolume  * 100)));
    if (kvv) localStorage.setItem(kvv, String(Math.round(_voiceVolume * 100)));
    const kce = audioSettingsKey('combatEnabled');
    const kcvv = audioSettingsKey('combatVol');
    if (kce) localStorage.setItem(kce, _combatSoundEnabled ? '1' : '0');
    if (kcvv) localStorage.setItem(kcvv, String(Math.round(_combatVolume * 100)));
    const kda = audioSettingsKey('dealAnim');
    if (kda) localStorage.setItem(kda, _dealAnimEnabled ? '1' : '0');
    pushVoicePrefToServer();
  }
  // Inform the server whenever the banter-voice setting changes (and
  // once at boot). The server uses this to skip 11labs synthesis when
  // NO client at the table has voice on — saves API tokens. Cheap
  // ack-less emit; reconnects republish on the next loadAudioSettings.
  function pushVoicePrefToServer() {
    try { socket.emit('lobby:setVoicePref', { enabled: _bannerVoiceEnabled }); }
    catch (_) {}
  }

  // Single combat-sound switch — covers all fight SFX (sword / lightning /
  // fart) and dungeon combat. (`url` param kept for callsite compatibility.)
  function combatSoundEnabled(_url) { return _combatSoundEnabled; }

  function applyMuteUI() {
    const btn = $('#muteBtn');
    if (btn) btn.textContent = _audioMuted ? '🔇' : '🔊';
    // Checkboxes read intuitively: ☑ means "this sound is ON".
    // `_audioMuted` is the inverse (mute = NOT on), hence the negation.
    const m = $('#audioMute');         if (m) m.checked = !_audioMuted;
    const v = $('#bannerVoiceToggle'); if (v) v.checked = _bannerVoiceEnabled;
    // Volume sliders — render the 0..1 internal value back as an 0..100
    // integer so the slider position and the % label both reflect the
    // persisted setting. Guarded null-safe because old cached
    // index.html may not have these elements yet.
    const cv  = $('#cardVolume');     if (cv)  cv.value  = String(Math.round(_cardVolume  * 100));
    const cvl = $('#cardVolumeVal');  if (cvl) cvl.textContent = `${Math.round(_cardVolume  * 100)}%`;
    const vv  = $('#voiceVolume');    if (vv)  vv.value  = String(Math.round(_voiceVolume * 100));
    const vvl = $('#voiceVolumeVal'); if (vvl) vvl.textContent = `${Math.round(_voiceVolume * 100)}%`;
    const cbt = $('#combatToggle');     if (cbt) cbt.checked = _combatSoundEnabled;
    const cbv = $('#combatVolume');     if (cbv) cbv.value = String(Math.round(_combatVolume * 100));
    const cbvl = $('#combatVolumeVal'); if (cbvl) cbvl.textContent = `${Math.round(_combatVolume * 100)}%`;
    const dat = $('#dealAnimToggle');   if (dat) dat.checked = _dealAnimEnabled;
  }
  applyMuteUI();

  // Play a base64-encoded MP3 (from the 11labs synthesis path).
  // Bypasses _audioMuted on purpose — card SFX and voice are
  // controlled independently. Caller is responsible for honoring
  // _bannerVoiceEnabled.
  //
  // Also notifies BlindMode that a banter clip is in flight so its
  // TTS queue can hold non-urgent narration until the audio ends
  // (prevents the screen-reader voice from talking over the
  // character voice or vice versa).
  // Shared "through the floor" SPEECH muffle — used IDENTICALLY both directions
  // (dungeon voices overheard at the table, and table banter overheard from the
  // dungeon). Lower Hz = more muffled.
  const VOICE_MUFFLE_HZ = 480;
  const VOICE_MUFFLE_VOL = 0.62;
  function playBase64Mp3(b64, mime = 'audio/mpeg', muffle = false, onEnded = null) {
    const done = () => { if (onEnded) { const cb = onEnded; onEnded = null; try { cb(); } catch (_) {} } };
    try {
      const bin = atob(b64);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      const url = URL.createObjectURL(blob);
      // Heard through the floor (dungeon voices at the table, or table banter from
      // the dungeon) → low-pass + quieter. ONE shared setting (VOICE_MUFFLE_*) so
      // both directions sound identical. 378Hz was inaudible, 820 too clear, 600
      // a touch clear — 480Hz reads as muddy-but-clearly-talking through a floor.
      if (muffle) {
        const ctx = audioCtx();
        if (ctx) {
          try {
            const a = new Audio(url);
            const srcNode = ctx.createMediaElementSource(a);
            const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = VOICE_MUFFLE_HZ; lp.Q.value = 0.7;
            const mBase = _voiceVolume * VOICE_MUFFLE_VOL;
            const g = ctx.createGain(); g.gain.value = mBase;
            srcNode.connect(lp); lp.connect(g); g.connect(ctx.destination);
            a._duckApply = (f) => { try { g.gain.value = mBase * f; } catch (_) {} };   // ducked under narration
            a.addEventListener('ended', () => { URL.revokeObjectURL(url); try { srcNode.disconnect(); lp.disconnect(); g.disconnect(); } catch (_) {} done(); });
            window.BlindMode?.notifyBanterStart?.(a);   // register clip for ducking + serialize
            a.play().catch(() => { URL.revokeObjectURL(url); done(); });
            return;
          } catch (_) { /* fall through to plain playback */ }
        }
      }
      const a = new Audio(url);
      const pBase = _voiceVolume;
      a.volume = pBase;
      a._duckApply = (f) => { try { a.volume = pBase * f; } catch (_) {} };   // ducked under narration
      a.addEventListener('ended', () => { URL.revokeObjectURL(url); done(); });
      window.BlindMode?.notifyBanterStart?.(a);
      a.play().catch(() => { URL.revokeObjectURL(url); done(); });
    } catch (_) { done(); }
  }

  // EVERY character-voice clip (11labs base64 or pre-cached URL, dungeon or table)
  // funnels through the clip serializer in blindMode.js so two AI voices never talk
  // over each other, and each clip gets a `_duckApply` handle so the ducking
  // controller can lower its volume while the screen reader talks (the narrator is
  // priority; the clip ducks but keeps playing). The bus calls back into `playClip`
  // (registered on first use) to emit a clip. If BlindMode isn't present (shouldn't
  // happen — it loads first), we fall back to a local serialize.
  const _voiceQueue = [];
  let _voiceBusy = false, _voiceFallback = null, _clipPlayerReg = false;
  // The bus's clip player: emit one clip and call onEnded when it finishes (or fails).
  function playClip(item, onEnded) {
    const done = () => { if (onEnded) { const cb = onEnded; onEnded = null; try { cb(); } catch (_) {} } };
    try {
      if (item.b64) { playBase64Mp3(item.b64, item.mime, item.muffle, done); return; }
      if (item.url) {
        const a = new Audio(item.url);
        const uBase = _voiceVolume;
        a.volume = uBase;
        a._duckApply = (f) => { try { a.volume = uBase * f; } catch (_) {} };   // ducked under narration
        a.addEventListener('ended', done, { once: true });
        a.addEventListener('error', done, { once: true });
        window.BlindMode?.notifyBanterStart?.(a);   // register clip for ducking + serialize
        a.play().catch(() => done());
        return;
      }
    } catch (_) {}
    done();
  }
  function _enqueueClip(item) {
    if (!item || !(item.b64 || item.url)) return;
    const bus = window.BlindMode;
    if (bus?.enqueueClip) {
      if (!_clipPlayerReg && bus.registerPlayer) { bus.registerPlayer(playClip); _clipPlayerReg = true; }
      bus.enqueueClip(item);
      return;
    }
    // Fallback (BlindMode absent): local one-at-a-time serialize.
    _voiceQueue.push(item);
    while (_voiceQueue.length > 4) _voiceQueue.shift();   // don't pile up stale lines
    _drainVoiceQueue();
  }
  function enqueueVoice(b64, mime, muffle = false) { _enqueueClip({ b64, mime: mime || 'audio/mpeg', muffle: !!muffle }); }
  function enqueueVoiceUrl(url, muffle = false) { _enqueueClip({ url, muffle: !!muffle }); }
  function _drainVoiceQueue() {
    if (_voiceBusy) return;
    const next = _voiceQueue.shift();
    if (!next) return;
    _voiceBusy = true;
    let advanced = false;
    const advance = () => { if (advanced) return; advanced = true; clearTimeout(_voiceFallback); _voiceBusy = false; _drainVoiceQueue(); };
    _voiceFallback = setTimeout(advance, 15000);   // hard safety so the queue can never stall
    playClip(next, advance);
  }

  // Warm up the cache so the first deal isn't a noticeable buffer
  // delay. Browsers will fetch lazily otherwise.
  for (const url of [...SHUFFLE_POOL, ...DEAL_POOL, ...YOUR_TURN_POOL, ...TURN_TICK_POOL, ...DEAL_CARD_POOL]) {
    try { new Audio(url).preload = 'auto'; } catch (_) {}
  }

  // Per-pool volume scalar — turn-tick is half the master volume so the
  // every-action tick doesn't drown out the bigger shuffle/deal hits.
  // Other pools use the master card-volume 1:1.
  // ── Web Audio "through the floor" muffle ────────────────────────────────
  // A LOW-PASS filter passes the bass and cuts the highs — a real muffled
  // sound, not just quieter. Used for poker SFX heard from down in the dungeon
  // and dungeon combat thumps heard back up at the table. Falls back to a plain
  // <audio> element if the Web Audio API is unavailable or errors.
  let _ac = null;
  function audioCtx() {
    if (_ac === null) { try { _ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { _ac = false; } }
    if (_ac && _ac.state === 'suspended') { try { _ac.resume(); } catch (_) {} }
    return _ac || null;
  }
  /** Play a URL at `volume` (0..1). If `muffle`, route through a low-pass
   *  biquad at `cutoff` Hz so it sounds distant/through-a-wall. */
  function playUrl(url, volume, muffle, cutoff = 460) {
    volume = Math.max(0, Math.min(1, volume));
    if (!url || volume <= 0) return;
    if (muffle) {
      const ctx = audioCtx();
      if (ctx) {
        try {
          const a = new Audio(url);
          const src = ctx.createMediaElementSource(a);
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff; lp.Q.value = 0.7;
          const g = ctx.createGain(); g.gain.value = volume;
          src.connect(lp); lp.connect(g); g.connect(ctx.destination);
          a.addEventListener('ended', () => { try { src.disconnect(); lp.disconnect(); g.disconnect(); } catch (_) {} });
          a.play().catch(() => {});
          return;
        } catch (_) { /* fall through to plain playback */ }
      }
    }
    try { const a = new Audio(url); a.volume = volume; a.play().catch(() => {}); } catch (_) {}
  }

  function playFromPool(pool, scale = 1) {
    if (_audioMuted || !pool.length) return;
    const url = pool[Math.floor(Math.random() * pool.length)];
    // Poker SFX are muffled (low-pass + quieter) ONLY while you're actually
    // VIEWING the dungeon screen — heard through the floor. Keyed on the current
    // screen, not the _inDungeon flag, so a stale flag can never muffle the table.
    if (document.body.dataset.screen === 'dungeon') playUrl(url, _cardVolume * scale * 0.6, true, 414);
    else playUrl(url, _cardVolume * scale, false);
  }

  // Trigger state — closed over by maybePlayCardSounds, reset between hands.
  let _audLastHandStartedAt = null;
  let _audLastBoardLen = 0;
  // Tracks whether THIS client was the actor on the previous render.
  // The your-turn chime fires only on the transition false → true so
  // we don't re-chime every render while the player is sitting on
  // their decision.
  let _audWasMyTurn = false;
  // Tracks the previous hand.actor playerId. The turn-tick fires
  // every time this changes to a different non-null actor — so every
  // player (bot or human) gets a soft "card slip" cue as the action
  // moves to them. Reset on hand-start so the first actor of a new
  // hand still triggers a tick (previous value would be stale).
  let _audLastActor = null;
  // Tracks whether a hand was live last tick, to fire the shuffle once on the
  // round's end (live → not-live transition).
  let _audWasLive = false;
  // Card-deal animation fires once per hand on the fresh PREFLOP edge.
  // Tracks the last hand.startedAt we animated (or chose to skip).
  let _dealAnimLastHand = null;
  // Deal pitch timing (ms): gap between cards + per-card flight. Shared by the
  // flying-card visual AND the "hold the hole card hidden until it lands" logic
  // so the two stay perfectly in step.
  const DEAL_STAGGER = 153, DEAL_FLIGHT = 790;
  // Reveal schedule: while a deal is animating, each in-hand seat's hole cards
  // start hidden and fade in as their flying card lands. _dealRevealMap maps
  // playerId -> [card0LandMs, card1LandMs] (absolute Date.now() timestamps).
  let _dealRevealPrepHand = null, _dealRevealHand = null, _dealRevealMap = null, _dealRevealUntil = 0;
  function maybePlayCardSounds(hand) {
    // Card audio is deliberately sparse: SHUFFLE at the END of a round, ONE
    // DEAL sound at the START, and a single card slip as the action reaches
    // each player. No more sound on every flop/turn/river card.
    const live = !!(hand && hand.state !== 'COMPLETE');
    // End of round → shuffle (deck gathered up at showdown / hand end).
    if (_audWasLive && !live) playFromPool(SHUFFLE_POOL);
    _audWasLive = live;

    if (!hand) {
      _audLastHandStartedAt = null;
      _audWasMyTurn = false;
      _audLastActor = null;
      return;
    }
    // Start of round → ONE deal sound. When the card-deal animation is on it
    // already plays its own composite deal sound, so only play here when the
    // animation is off (avoids a double).
    if (hand.startedAt && hand.startedAt !== _audLastHandStartedAt) {
      _audLastHandStartedAt = hand.startedAt;
      _audWasMyTurn = false;
      _audLastActor = null;
      if (!_dealAnimEnabled) playFromPool(DEAL_POOL);
    }
    // Single card slip as the action moves to a new player (bot or human).
    if (hand.actor && hand.actor !== _audLastActor) {
      _audLastActor = hand.actor;
      playFromPool(TURN_TICK_POOL, 0.7);
    } else if (!hand.actor) {
      _audLastActor = null;
    }
    // Solo your-turn chime — only this client, only on the edge.
    // hand.actor is the playerId currently on the clock. Other
    // clients won't satisfy `actor === state.me.player_id` so they
    // hear nothing — exactly what we want.
    const isMyTurn = !!(state.me && hand.actor && hand.actor === state.me.player_id);
    if (isMyTurn && !_audWasMyTurn) {
      playFromPool(YOUR_TURN_POOL);
    }
    _audWasMyTurn = isMyTurn;
  }

  // Null-safe: a stale cached index.html may not have the mute button
  // yet. Without the guard, addEventListener throws here and the rest
  // of the IIFE (socket handlers, render wiring, EVERYTHING below)
  // never runs — chat log freezes, table goes static. Same defensive
  // pattern any new DOM hook in this file should use.
  // Speaker icon no longer toggles mute on click — it would collide
  // with the checkboxes that control the same setting. Clicking the
  // icon now just opens the audio menu (the wrapper handler below
  // does the toggle). Mute state is changed exclusively via the
  // "Card sounds" checkbox to keep the model unambiguous.
  // (Hover users see the menu automatically; this click handler is
  // for touch / keyboard.)

  // Card-sounds checkbox — ☑ means "sounds ON" (so _audioMuted is
  // the INVERSE of checkbox state). Reads correctly off the label.
  const audioMuteCheckbox = $('#audioMute');
  if (audioMuteCheckbox) {
    audioMuteCheckbox.addEventListener('change', (e) => {
      _audioMuted = !e.target.checked;
      saveAudioSettings();
      applyMuteUI();
      // Audible confirmation when toggling sounds back ON.
      if (!_audioMuted) playFromPool(DEAL_POOL);
    });
  }
  // AI-character-voice checkbox — toggles 11labs banter playback.
  // Doesn't affect the server (banter audio still streams in); we just
  // skip playback on this client. Stop propagation so clicking the
  // checkbox doesn't also toggle the mute button via bubble.
  const voiceCheckbox = $('#bannerVoiceToggle');
  if (voiceCheckbox) {
    voiceCheckbox.addEventListener('change', (e) => {
      _bannerVoiceEnabled = !!e.target.checked;
      saveAudioSettings();
    });
  }
  // Combat-sound channel — one on/off toggle + a volume slider.
  const combatToggle = $('#combatToggle');
  if (combatToggle) combatToggle.addEventListener('change', (e) => { _combatSoundEnabled = !!e.target.checked; saveAudioSettings(); });
  const combatVolSlider = $('#combatVolume');
  if (combatVolSlider) {
    combatVolSlider.addEventListener('input', (e) => {
      const pct = parseInt(e.target.value, 10) || 0;
      _combatVolume = Math.max(0, Math.min(100, pct)) / 100;
      const lbl = $('#combatVolumeVal'); if (lbl) lbl.textContent = `${pct}%`;
      saveAudioSettings();
    });
  }
  // 🃏 Card-deal animation toggle.
  const dealAnimToggle = $('#dealAnimToggle');
  if (dealAnimToggle) {
    dealAnimToggle.addEventListener('change', (e) => { _dealAnimEnabled = !!e.target.checked; saveAudioSettings(); });
  }
  // Volume sliders — 0..100 integer percent. `input` event fires on
  // every drag tick for live feedback (the % label updates in real
  // time); `change` would only fire on release. Saving on every tick
  // is fine — localStorage writes are cheap and the saveAudioSettings
  // server roundtrip only fires for the AI-voice toggle, not volume.
  const cardVolSlider = $('#cardVolume');
  if (cardVolSlider) {
    cardVolSlider.addEventListener('input', (e) => {
      const pct = parseInt(e.target.value, 10) || 0;
      _cardVolume = Math.max(0, Math.min(100, pct)) / 100;
      const lbl = $('#cardVolumeVal'); if (lbl) lbl.textContent = `${pct}%`;
      saveAudioSettings();
    });
    // Audible preview on release so the player can hear the level they
    // just picked. `change` (not `input`) so we don't fire every tick.
    cardVolSlider.addEventListener('change', () => {
      if (!_audioMuted) playFromPool(TURN_TICK_POOL, 0.5);
    });
  }
  const voiceVolSlider = $('#voiceVolume');
  if (voiceVolSlider) {
    voiceVolSlider.addEventListener('input', (e) => {
      const pct = parseInt(e.target.value, 10) || 0;
      _voiceVolume = Math.max(0, Math.min(100, pct)) / 100;
      const lbl = $('#voiceVolumeVal'); if (lbl) lbl.textContent = `${pct}%`;
      saveAudioSettings();
    });
  }
  // Stop label/checkbox clicks inside the popover from bubbling to the
  // mute button (which would toggle SFX every time the user changed a
  // voice setting — surprising and annoying).
  const audioMenuPop = $('#audioMenuPop');
  if (audioMenuPop) {
    audioMenuPop.addEventListener('click', (e) => e.stopPropagation());
  }
  // Touch / keyboard: tap anywhere on the wrapper (including the
  // speaker icon) to reveal the menu. Outside click closes it.
  const audioMenu = $('#audioMenu');
  if (audioMenu) {
    const audioBtn = $('#muteBtn');
    // Proper disclosure semantics for screen readers: the 🔊 button reports
    // aria-expanded, opening MOVES FOCUS into the panel (so a SR user is
    // "inside" the dropdown), and Escape closes it + returns focus to the button.
    const setAudioOpen = (open) => {
      audioMenu.classList.toggle('is-open', open);
      if (audioBtn) audioBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { const f = audioMenuPop && audioMenuPop.querySelector('input, a, button, select'); if (f) f.focus(); }
    };
    (audioBtn || audioMenu).addEventListener('click', (e) => {
      e.stopPropagation();
      setAudioOpen(!audioMenu.classList.contains('is-open'));
    });
    audioMenu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && audioMenu.classList.contains('is-open')) {
        e.stopPropagation(); setAudioOpen(false); if (audioBtn) audioBtn.focus();
      }
    });
    document.addEventListener('click', (e) => {
      if (audioMenu.contains(e.target)) return;
      setAudioOpen(false);
    });
  }

  // ===== Help modal — consolidates the side-panel content. Always
  //       available from the topbar "?" button; auto-discoverable on
  //       mobile where the side panels are hidden. =====
  $('#helpBtn').addEventListener('click', () => {
    const m = $('#helpModal'); if (m) m.hidden = false;
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-help]')) {
      const m = $('#helpModal'); if (m) m.hidden = true;
    }
  });

  // ===== Topbar overflow menu (mobile) — hamburger toggles the
  //       management-button row that's collapsed into a dropdown on
  //       narrow viewports. Desktop CSS keeps the row inline and
  //       hides the toggle, so these handlers are inert there. =====
  const topbarMenu       = $('#topbarMenu');
  const topbarMenuToggle = $('#topbarMenuToggle');
  if (topbarMenu && topbarMenuToggle) {
    const closeMenu = () => {
      topbarMenu.classList.remove('is-open');
      topbarMenuToggle.setAttribute('aria-expanded', 'false');
    };
    topbarMenuToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !topbarMenu.classList.contains('is-open');
      topbarMenu.classList.toggle('is-open', open);
      topbarMenuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // Tap a menu item → close the menu. Use capture so the close runs
    // before the item's own handler (which often opens a modal that
    // would otherwise be hidden underneath the still-open menu).
    topbarMenu.addEventListener('click', (e) => {
      if (e.target.closest('button')) closeMenu();
    });
    // Tap outside the menu (and not the toggle) → close.
    document.addEventListener('click', (e) => {
      if (topbarMenu.contains(e.target) || topbarMenuToggle.contains(e.target)) return;
      if (topbarMenu.classList.contains('is-open')) closeMenu();
    });
    // Escape closes it for keyboard users.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && topbarMenu.classList.contains('is-open')) closeMenu();
    });

    // ── Blind-mode toggle living inside this options menu — a tap-friendly
    //    equivalent of the backtick keyboard shortcut, so phone/tablet users
    //    (who have no backtick key) can engage spoken play-by-play. ──
    const blindBtn = $('#blindModeBtn');
    if (blindBtn) {
      const syncBlindBtn = () => {
        const on = !!(window.BlindMode && window.BlindMode.isOn && window.BlindMode.isOn());
        blindBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        blindBtn.classList.toggle('is-active', on);
        blindBtn.textContent = on ? '👂 Blind Mode: On' : '👂 Blind Mode';
      };
      blindBtn.addEventListener('click', () => {
        if (window.BlindMode && window.BlindMode.toggle) window.BlindMode.toggle();
        syncBlindBtn();
      });
      // Re-sync the label each time the menu opens, so it stays honest even if
      // blind mode was toggled elsewhere (backtick key, voice command).
      topbarMenuToggle.addEventListener('click', syncBlindBtn);
      syncBlindBtn();
    }
  }

  let _chatIdleTimer = null;   // drifts the chat back to newest after the reader idles
  let _chatStuck = true;       // sticky-to-bottom; only a deliberate scroll-up clears it
  // The audio-settings menu (#audioMenu) is a SINGLE shared element. We move it
  // into the dungeon header while delving and back to the poker topbar otherwise,
  // so both screens get the identical control with one set of handlers (no
  // duplicate IDs). Only one screen is visible at a time, so one menu suffices.
  let _audioHome = null;
  function placeAudioMenu(name) {
    const am = $('#audioMenu'); if (!am) return;
    if (!_audioHome) _audioHome = am.parentNode;   // its table-topbar home (captured before any move)
    const slot = name === 'dungeon' ? $('#dungeonAudioSlot') : _audioHome;
    if (slot && am.parentNode !== slot) { slot.appendChild(am); am.classList.remove('is-open'); }
  }
  function setScreen(name) {
    document.body.dataset.screen = name;
    placeAudioMenu(name);
    // Landing on the table (incl. returning from the dungeon) → snap chat to newest.
    if (name === 'table') requestAnimationFrame(scrollChatToBottom);
  }
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('is-error', !!isError);
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 3000);
  }
  // In-app confirmation dialog. Used instead of native confirm() — confirm()
  // blocks the JS thread and is NOT narrated by BlindMode (Josh would get a
  // silent, invisible-to-TTS popup). Reuses the .modal CSS. Returns a Promise
  // resolving true (confirmed) / false (cancelled). Backdrop / Escape / Cancel →
  // false; focus defaults to Cancel (the safe choice for destructive actions).
  function confirmDialog({ title = 'Are you sure?', body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
      let el = $('#confirmDialog');
      if (!el) {
        el = document.createElement('div');
        el.id = 'confirmDialog';
        el.className = 'modal';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-labelledby', 'confirmDialogTitle');
        el.innerHTML =
          '<div class="modal__backdrop"></div>' +
          '<div class="modal__panel">' +
            '<h2 class="modal__title" id="confirmDialogTitle"></h2>' +
            '<p class="modal__body" id="confirmDialogBody"></p>' +
            '<div class="modal__actions">' +
              '<button class="btn btn--ghost" id="confirmDialogNo"></button>' +
              '<button class="btn" id="confirmDialogYes"></button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(el);
      }
      const yes = $('#confirmDialogYes'), no = $('#confirmDialogNo'), backdrop = el.querySelector('.modal__backdrop');
      const bodyEl = $('#confirmDialogBody');
      $('#confirmDialogTitle').textContent = title;
      bodyEl.textContent = body; bodyEl.hidden = !body;
      yes.textContent = confirmLabel; no.textContent = cancelLabel;
      yes.className = 'btn ' + (danger ? 'btn--danger' : 'btn--primary');
      el.hidden = false;
      if (window.BlindMode?.isOn?.()) window.BlindMode.speak(`${title} ${body} ${confirmLabel}, or ${cancelLabel}.`, 'urgent');
      const close = (val) => {
        el.hidden = true;
        yes.onclick = no.onclick = backdrop.onclick = null;
        document.removeEventListener('keydown', onKey, true);
        resolve(val);
      };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); } };
      yes.onclick = () => close(true);
      no.onclick = () => close(false);
      backdrop.onclick = () => close(false);
      document.addEventListener('keydown', onKey, true);
      setTimeout(() => no.focus(), 0);   // safe default for keyboard / screen-reader users
    });
  }

  const socket = io({ autoConnect: false });
  socket.on('connect_error', (err) => toast('Connection issue: ' + (err.message || 'unknown'), true));

  socket.on('roster', ({ players, defaultStack }) => {
    state.roster = players || [];
    state.defaultStack = defaultStack || state.defaultStack;
    if (state.me) {
      const fresh = state.roster.find(p => p.player_id === state.me.player_id);
      if (fresh) { state.me = fresh; paintMe(); }
    }
    if (document.body.dataset.screen === 'roster') renderRoster();
    if (document.body.dataset.screen === 'confirm') renderConfirm();
    // The right-side sidebar leaderboard updates whenever the roster
    // changes (chip totals, gear purchases, bot wins, etc.).
    renderSidebarLeaderboard();
    // Left sidebar bank reflects my own gear + chips after roster
    // events (which fire on hand completion, gear purchases, etc.).
    renderSidebarBank();
  });

  socket.on('table:state', (st) => {
    state.table = st;
    // Remember the AI personalities seated alongside me — this browser's human —
    // for the poker bot-picker's "↻ Last party" button (seating bots is free).
    try {
      const meId = state.me?.player_id;
      const seats = st.seats || [];
      const myId = (s) => s.playerId || s.player_id;
      if (meId && seats.some(s => s && s.occupied && !s.isBot && myId(s) === meId)) {
        const bots = seats.filter(s => s && s.occupied && s.isBot && myId(s)).map(myId);
        if (bots.length) localStorage.setItem('fp_lastPokerParty', JSON.stringify(bots));
      }
    } catch (_) {}
    if (!st.hand) {
      state.myHole = null;
    } else if (state.me && st.hand.state !== 'COMPLETE') {
      // Defensive: if I'm a participant in this hand but I don't have my
      // hole cards locally yet, ask the server to re-send them. Handles any
      // edge case where the deal-time emit raced a reconnect.
      const meInHand = st.hand.players?.find(p => p.playerId === state.me.player_id);
      if (meInHand && !state.myHole) {
        socket.emit('table:requestHole', null, () => {});
      }
    }
    if (document.body.dataset.screen === 'table') {
      _inDungeon = false;   // you're looking at the table → not in the dungeon (self-heal any stale flag)
      renderTable();
      // Keep topbar / sit-out button label in sync with seat state.
      if (state.me) paintMe();
    } else if (_inDungeon) {
      // Down in the dungeon: don't render the felt, but still fire the poker
      // SFX so they drift down muffled (playFromPool damps them to 0.3×).
      maybePlayCardSounds(st.hand);
    }
    // Forward to blind-mode for TTS narration of state deltas. Module
    // no-ops when mode is off, so this is safe to call unconditionally.
    window.BlindMode?.onState?.(st);
  });

  socket.on('table:hole', ({ playerId, hole }) => {
    if (state.me && playerId === state.me.player_id) {
      state.myHole = hole;
      if (document.body.dataset.screen === 'table') renderTable();
      // Speak my hole cards (only to me — the emit is private already).
      window.BlindMode?.onHole?.(hole);
    }
  });

  // ===== 🗡️ Dungeon side-game =====
  let _dungeonSel = [];        // selected enemy uids (combat targeting)
  let _dungeonAllySel = null;  // selected ALLY playerId (buff / dispel targeting — click a party card)
  let _dungeonSoundSeen = 0;   // highest dungeon-log id whose sound we've played
  let _iFellInDungeon = false;  // my hero is dead-but-present (spectating, awaiting revive)
  let _recruitOpen = false;    // dungeon "Recruit AI ▾" dropdown open/closed
  let _spellbookOpen = false;  // caster "📖 Spellbook ▾" dropdown open/closed
  let _blindHelp = false;      // blind "learn mode" (?): keys are SPOKEN, not fired
  let _raiseMenu = null;       // blind poker: R opened the raise menu — {minTo, halfTo, potTo, cap}; numbers 1-4 pick a bet
  let _cardReader = false;     // blind poker: 0 toggled card-reader mode — numbers read single cards instead of seats
  let _dunCancelArm = 0;       // blind dungeon: timestamp of an armed "." cancel-run confirm
  let _dunTarget = null;       // blind dungeon: pending action awaiting an enemy pick ({kind, slot, label})
  let _dunEnemyMode = false;   // blind dungeon: "inspect enemies" browse mode (E toggles; Tab cycles)
  let _dunEnemyIdx = -1;       // current enemy index while inspecting
  let _dunQueuedAttack = null; // blind dungeon: enemy uid chosen (Return in E-mode) to attack when your turn comes
  let _dunPrevMyTurn = false;  // edge-detect the start of the blind player's dungeon turn
  let _dunSbMode = false;      // blind dungeon: spellbook open (numbers pick a spell LEVEL, Tab cycles spells)
  let _dunMmMenu = null;       // blind dungeon: metamagic toggle menu open ([{key,name,adj,on}] or null) — numbers toggle
  let _dunAllyPick = null;     // blind dungeon: an ally-targeted spell awaiting an ALLY choice — {slot,label,allies:[playerId]} (numbers pick, Return = smart auto)
  let _dunDispelPick = null;   // blind dungeon: Dispel Magic awaiting a target — {slot,label,targets:[{kind:'ally'|'foe',id,name}]} (numbers pick, Return = smart auto)
  let _dunModePick = null;     // blind dungeon: Channel awaiting a mode — {slot,label} (1 = heal/defensive, 2 = sear/offensive, Return = auto)
  // Full-art PORTRAITS (paired from each token's Foundry source) used as the
  // background of hero/villain cards. The manifest lists which basenames have a
  // portrait; tokens without one keep the plain card background.
  let _portraitSet = null;
  (function loadPortraits() {
    fetch('/portraits/manifest.json', { cache: 'force-cache' })
      .then(r => (r.ok ? r.json() : []))
      .then(arr => { _portraitSet = new Set(Array.isArray(arr) ? arr : []); if (state.dungeon) renderDungeon(); })
      .catch(() => { _portraitSet = new Set(); });
  })();
  // Token path / avatar id → its portrait URL, or null when none was paired.
  function portraitFor(pathOrId) {
    if (!_portraitSet || !pathOrId || typeof pathOrId !== 'string') return null;
    const mm = pathOrId.match(/([^/]+?)(?:\.\w+)?$/);
    const base = mm && mm[1];
    return (base && _portraitSet.has(base)) ? `/portraits/${base}.webp` : null;
  }
  // Inline style for a card whose backdrop is a full-art portrait — a dark
  // gradient over the cover keeps the name/HP/AC text legible on any art.
  function portraitBg(url) {
    // Lighter scrim so the portrait shows through (was .60→.84, which crushed dark
    // art like the vampires). Stays darker toward the BOTTOM, where the name/HP
    // text sits, so legibility holds (text also carries its own shadow).
    return url ? `;background-image:linear-gradient(rgba(8,10,8,.20),rgba(8,10,8,.40) 55%,rgba(8,10,8,.78)),url('${escapeAttr(url)}');background-size:cover;background-position:center top` : '';
  }
  let _dunSbLevel = null;      // blind spellbook: currently-chosen spell level
  let _dunSbIdx = -1;          // blind spellbook: current spell index within the chosen level (Tab cycles)
  let _dunSessionMode = false; // blind dungeon: Esc "session menu" open (Tab cycles spectate/leave/cancel)
  let _dunSessionIdx = 0;      // blind session menu: current item index
  let _dunLootClaiming = 0;    // blind dungeon: timestamp throttle so won loot is auto-claimed without spamming
  let _spectating = false;     // watching the dungeon (not a combatant) — heckle-only

  function playDungeonSound(url, vol) {
    if (!url || !combatSoundEnabled(url)) return;   // honors the combat-sound toggles
    try {
      const a = new Audio(url);
      const v = Math.max(0, Math.min(1, vol));
      a.volume = v;
      a.play().catch(() => {});
      // Long clips (the music-flavored spell sounds — ABBA's Haste, the Hetfield
      // bolt, ghosts n stuff…) start FADING at 4s and are silent by 5s. Short
      // weapon/spell hits end on their own long before the fade ever fires.
      setTimeout(() => {
        if (a.paused || a.ended) return;
        const t0 = Date.now();
        const iv = setInterval(() => {
          const k = 1 - (Date.now() - t0) / 1000;   // 1 → 0 across one second
          if (k <= 0 || a.ended) { clearInterval(iv); try { a.pause(); } catch (_) {} }
          else a.volume = v * k;
        }, 50);
      }, 4000);
    } catch (_) {}
  }
  function enterDungeon() {
    socket.emit('dungeon:enter', null, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'Could not enter the dungeon.', true); return; }
      _inDungeon = true; _spectating = false; _dungeonSel = []; _dungeonSoundSeen = 0; _iFellInDungeon = false;
      state.dungeon = resp.state || null;
      setScreen('dungeon');
      renderDungeon();
    });
  }
  // Spectate the run — watch + heckle without leaving your seat or fighting.
  function spectateDungeon() {
    socket.emit('dungeon:spectate', null, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'Nobody is in the dungeon right now.', true); return; }
      _inDungeon = true; _spectating = true; _dungeonSel = []; _dungeonSoundSeen = 0;
      state.dungeon = resp.state || null;
      setScreen('dungeon');
      renderDungeon();
    });
  }
  // Telegraph my current target to the rest of the party — the server rebroadcasts
  // it as d.targeting and everyone sees a colored 🎯 aim ring on that monster.
  // Covers the sighted click-select AND the blind E-mode lock (deduped here).
  let _lastAim = null;
  function emitAim(uid) {
    const u = (typeof uid === 'string' && uid) ? uid : null;
    if (u === _lastAim) return;
    _lastAim = u;
    socket.emit('dungeon:target', { uid: u });
  }
  function dungeonAction(kind, payload) {
    if (payload && typeof payload.targetUid === 'string') emitAim(payload.targetUid);   // acting on a foe IS targeting it
    socket.emit('dungeon:action', { kind, ...(payload || {}) }, (resp) => {
      if (resp && resp.ok === false && resp.error) {
        toast(resp.error, true);
        // Blind mode: the refusal reason is SPOKEN ("Gabriel already has Bull's
        // Strength", "no level-3 slots left") — silence told Josh nothing.
        try { if (window.BlindMode?.isOn?.()) window.BlindMode.speak(resp.error, 'urgent'); } catch (_) {}
      }
      else if (resp && resp.queued) {
        // Off-turn act → the server PRE-LOADED it; it fires when the turn comes.
        toast(`⏳ ${resp.label} queued — fires the moment your turn begins (queue again to replace it)`);
        // Blind: E-mode attack locks announce themselves with the enemy's name,
        // so only speak the generic line for queued ABILITIES.
        try { if (kind !== 'attack' && window.BlindMode?.isOn?.()) window.BlindMode.speak(`${resp.label} queued — it fires when your turn comes.`, 'polite'); } catch (_) {}
      }
    });
  }
  // Bail out of the fight but keep watching — banks gold, drops to spectator,
  // stays on the dungeon screen. (_spectating is set first so the dungeon:exit
  // our own bail triggers won't bounce us back to the poker table.)
  function bailToSpectate() {
    _spectating = true; _dungeonSel = [];
    socket.emit('dungeon:bailWatch', null, (resp) => {
      if (!resp?.ok) { _spectating = false; toast(resp?.error || 'Could not bail.', true); renderDungeon(); return; }
      if (resp.state) state.dungeon = resp.state;
      toast('👁 Bailed out — you bank your gold and keep watching.');
      renderDungeon();
    });
  }
  function returnFromDungeon() {
    // Spectators never left their seat and aren't combatants — just drop out of
    // the dungeon room and go back to the table view (no bail, no re-seat).
    if (_spectating) {
      _spectating = false; _inDungeon = false;
      socket.emit('dungeon:leave', null, () => {});
      setScreen('table');
      return;
    }
    _inDungeon = false;
    socket.emit('dungeon:leave', null, () => {});      // banks gold if still active
    // fromDungeon: come back as a spectator without evicting an AI from its seat.
    socket.emit('table:join', { tableId: 'main', fromDungeon: true }, () => {});
    setScreen('table');
  }
  // Force-cancel the ENTIRE run for everyone (escape hatch for a stuck run).
  // The server bails out every delver — each banks their share — and ends the
  // run; our own dungeon:exit then surfaces us back to the table.
  function cancelDungeon() {
    socket.emit('dungeon:cancel', null, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'Could not cancel the dungeon.', true); return; }
      toast('🛑 Dungeon run cancelled — everyone heads back upstairs.');
    });
  }

  socket.on('dungeon:state', (st) => {
    state.dungeon = st;
    // Remember THIS BROWSER's last dungeon crew (i.e. the human behind whatever
    // persona is logged in — localStorage is per-human memory): the AI allies in
    // my current run feed the recruit panel's "↻ Last party" button.
    try {
      const meId = state.me?.player_id;
      if (meId && (st.party || []).some(p => p.playerId === meId && !p.left)) {
        const allies = (st.party || []).filter(p => p.isBot && !p.left).map(p => p.playerId).slice(0, 3);
        if (allies.length) localStorage.setItem('fp_lastDunParty', JSON.stringify(allies));
      }
    } catch (_) {}
    // Play the fresh log sounds (this client is IN the dungeon, so it hears
    // combat clearly — the table hears the muffled echo). Up to the first THREE
    // DISTINCT new sounds, staggered — the old "newest only" rule silently ATE a
    // spell's blast whenever the kill ended the room, because the victory/level-up
    // notes (with their own chime) landed after it in the same broadcast.
    if (st.log && st.log.length) {
      let maxT = _dungeonSoundSeen;
      const fresh = [];
      for (const e of st.log) {
        if (e.t > maxT) maxT = e.t;
        if (e.t > _dungeonSoundSeen && e.sound) fresh.push(e);   // log order: oldest first → the kill-shot plays before the fanfare
      }
      const seen = new Set();
      let i = 0;
      for (const e of fresh) {
        if (seen.has(e.sound)) continue;
        seen.add(e.sound);
        if (i < 3) { const snd = e.sound, delay = i * 350; setTimeout(() => playDungeonSound(snd, _combatVolume), delay); }
        i++;
      }
      _dungeonSoundSeen = maxT;
    }
    if (document.body.dataset.screen === 'dungeon') renderDungeon();
    // Fallen-but-present: my hero died yet the run continues. We are NO LONGER kicked
    // out — we stay and spectate, and a cleric/oracle may still revive us (Breath of
    // Life now, Resurrection at the end of the room). Announce the transitions so a
    // blind player knows what happened instead of going silent.
    try {
      const meId2 = state.me?.player_id;
      const mine = meId2 && (st.party || []).find(x => x.playerId === meId2);
      const fellNow = !!(mine && mine.dead && !mine.left);
      if (fellNow && !_iFellInDungeon) {
        _iFellInDungeon = true;
        toast('☠️ You have fallen. Your allies may yet revive you — keep watching.', true);
        window.BlindMode?.speak?.('You have fallen in the dungeon. You are now spectating. A cleric or oracle may still revive you with a Breath of Life, or raise you at the end of the room.', 'urgent');
      } else if (!fellNow && _iFellInDungeon && mine && !mine.left && mine.hp > 0) {
        _iFellInDungeon = false;
        toast('✨ You are back on your feet!');
        window.BlindMode?.speak?.('You have been revived and are back in the fight.', 'urgent');
      } else if (!mine) {
        _iFellInDungeon = false;
      }
    } catch (_) {}
    // Blind-mode narration (no-ops when blind mode is off).
    window.BlindMode?.onDungeonState?.(st);
  });

  // A run started/changed/ended somewhere on this table. Tracked so the money
  // menu can offer "Spectate the Dungeon" only while there's something to watch.
  socket.on('dungeon:active', (summary) => {
    const wasActive = state.dungeonActive;
    state.dungeonActive = !!(summary && summary.active);
    state.dungeonSummary = summary || null;
    if (state.dungeonActive !== wasActive && document.body.dataset.screen === 'table' && state.me) paintMe();
  });

  socket.on('dungeon:say', ({ audio, audioMime } = {}) => {
    // AI ally trash-talk voice clip — CLEAR, only when you're actually in the
    // dungeon. At the table you hear the muffled echo below instead (so a stale
    // dungeon-room membership can't leak a full-clarity voice up to the table).
    // Queued so two allies never talk over each other.
    if (_inDungeon && _bannerVoiceEnabled && audio) enqueueVoice(audio, audioMime || 'audio/mpeg', false);
  });

  socket.on('dungeon:voiceecho', ({ audio, audioMime } = {}) => {
    // Dungeon ally voices overheard from up at the table — muffled through the
    // floor, like the combat echo. Dungeon players skip it (they got it clear).
    if (_inDungeon || !_bannerVoiceEnabled || !audio) return;
    enqueueVoice(audio, audioMime || 'audio/mpeg', true);
  });

  socket.on('dungeon:echo', ({ sound } = {}) => {
    // Muffled basement thumps for players still at the table. The dungeon
    // player hears full combat via dungeon:state, so they skip this.
    if (_inDungeon || !sound || !combatSoundEnabled(sound)) return;
    playUrl(sound, _combatVolume * 0.5, true, 378);   // low-pass ~378Hz: distant, through the floor (10% more muffled)
  });

  socket.on('dungeon:sfx', ({ sound } = {}) => {
    // A single staggered swing sound for the IN-DUNGEON player — used by chain
    // cleaves so each hit is heard distinctly (the state broadcast only plays
    // the newest log sound). Spectators in the room hear it too.
    if (!_inDungeon || !sound) return;
    playDungeonSound(sound, _combatVolume);
  });

  socket.on('dungeon:exit', (exit) => {
    // Per-player now: only surface back to the table if this exit is MINE.
    if (!exit || exit.playerId !== state.me?.player_id) return;
    // If I chose to bail-but-keep-watching, my own bail's exit shouldn't yank me
    // back to the poker table — stay on the dungeon screen as a spectator.
    if (_spectating) { renderDungeon(); return; }
    state.dungeonExit = exit;
    if (document.body.dataset.screen === 'dungeon') renderDungeon();
    setTimeout(() => {
      const dead = exit.reason === 'dead';
      toast(dead ? '☠️ You fell in the dungeon — your share is lost.'
                 : `🪜 Back at the table with ${formatChips(exit.goldBanked || 0)} gp.`, dead);
      returnFromDungeon();
    }, 1400);
  });

  // Magic-item summary for a bot's gear, e.g. "+2 Longsword · +1 Ring of
  // Protection" — same labels the poker table uses (GEAR_META, defined below).
  function dungeonGearTip(gear) {
    if (!gear) return 'no magic items';
    const parts = GEAR_SLOTS.map(slot => { const t = gear[slot]; return t ? `+${t} ${GEAR_META[slot].label}` : null; }).filter(Boolean);
    return parts.length ? parts.join(' · ') : 'no magic items';
  }
  // A strip of PF1-system debuff icons (sickened / paralyzed / asleep / prone)
  // shown on a hero or monster card. Each is a small badge with a hover label.
  // Hover title = "Name — short summary" (falls back to just the name).
  const statusTitle = (c) => c.desc ? `${c.label} — ${c.desc}` : c.label;
  function condIcons(list) {
    if (!list || !list.length) return '';
    return `<div class="dcond">` + list.map(c => {
      const img = `<img class="dcond__i" src="${escapeAttr(c.icon)}" alt="${escapeAttr(c.label)}" title="${escapeAttr(statusTitle(c))}" loading="lazy" />`;
      // A COUNT badge (e.g. Mirror Image decoys remaining) — overlaid on the icon so
      // you can watch it tick down as decoys pop. Inline-styled to avoid a CSS dep.
      if (c.n != null && c.n >= 1) {
        return `<span style="position:relative;display:inline-block;line-height:0">${img}`
          + `<span title="${escapeAttr(statusTitle(c))}" style="position:absolute;bottom:-3px;right:-3px;min-width:11px;height:13px;padding:0 2px;background:#1a1208;border:1px solid var(--brass-bright,#c9a44a);color:var(--brass-bright,#c9a44a);font-size:9px;font-weight:800;line-height:12px;text-align:center;border-radius:7px">${c.n}</span>`
          + `</span>`;
      }
      return img;
    }).join('') + `</div>`;
  }
  // A strip of active BUFF icons (rage / shield / bless / smite / judgement…) at
  // the top-left of a hero token — green ring marks a boon (vs the red debuff ring).
  function buffIcons(list) {
    if (!list || !list.length) return '';
    return `<div class="dbuff">` + list.map(c =>
      `<img class="dbuff__i" src="${escapeAttr(c.icon)}" alt="${escapeAttr(c.label)}" title="${escapeAttr(statusTitle(c))}" loading="lazy" />`
    ).join('') + `</div>`;
  }
  // Live-tick the dungeon auto-skip countdown badges (set by renderDungeon) so
  // the seconds visibly tick down between server state updates. Started once.
  setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('.dpc__afk[data-afk-at]').forEach(el => {
      const at = Number(el.getAttribute('data-afk-at')) || 0;
      const s = Math.max(0, Math.ceil((at - now) / 1000));
      el.textContent = `⏱ ${s}s`;
      el.classList.toggle('is-urgent', (at - now) < 3000);
    });
  }, 250);
  // ── Initiative re-order (FLIP) ──────────────────────────────────────────────
  // Cards sort by initiative (highest → left); when that order changes — every
  // room, as new initiative is rolled — they SLIDE to their new slots via a FLIP
  // animation instead of snapping. Positions that don't change don't animate.
  const _byInit = (a, b) => ((b.init ?? -Infinity) - (a.init ?? -Infinity));
  function _flipCapture(container, attr) {
    const m = {};
    if (container) container.querySelectorAll('[' + attr + ']').forEach(el => { m[el.getAttribute(attr)] = el.getBoundingClientRect(); });
    return m;
  }
  function _flipPlay(container, attr, old) {
    if (!container) return;
    container.querySelectorAll('[' + attr + ']').forEach(el => {
      const o = old[el.getAttribute(attr)]; if (!o) return;
      const n = el.getBoundingClientRect();
      const dx = o.left - n.left, dy = o.top - n.top;
      if ((dx || dy) && el.animate) el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0,0)' }],
        { duration: 340, easing: 'cubic-bezier(.2,.75,.3,1)' });
    });
  }
  let _dunEneSig = null;   // last initiative signature → drives the villains' two-phase reveal
  function renderDungeon() {
    const d = state.dungeon;
    if (!d) return;
    const meId = state.me?.player_id;
    const turnId = (d.turn && d.turn.kind === 'party') ? d.turn.id : null;
    const isMyTurn = turnId === meId;
    // Blind: target locks now ride the SERVER-side action queue (the E-menu lock
    // sends the attack early; the server fires it when the turn comes), so the
    // old client-side edge-fire is gone — it would double-attack. Just tidy the
    // local mirror once the turn arrives.
    if (isMyTurn && !_dunPrevMyTurn) _dunQueuedAttack = null;
    // A pending "select a target" prompt never survives a TURN BOUNDARY — a stale
    // one would silently swallow the first number key of the NEXT turn and fire
    // last turn's action without offering a choice (Josh's "it just attacks").
    if (isMyTurn !== _dunPrevMyTurn) _dunTarget = null;
    _dunPrevMyTurn = isMyTurn;
    const turnName = turnId ? ((d.party || []).find(m => m.playerId === turnId)?.nickname || 'someone') : null;

    const meta = $('#dungeonMeta');
    if (meta) meta.textContent = `Depth ${d.depth} · Round ${d.round || 0} · 💰 ${formatChips(d.runGold)} gp pool`;

    // Stable per-player aim color (same hash on every client → everyone sees the
    // same color for the same person's 🎯 ring).
    const aimHue = (pid) => { let h = 7; for (const ch of String(pid)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
    const ene = $('#dungeonEnemies');
    const _buildEnemies = (list) => list.length
      ? list.map(e => {
          const dead = !e.alive;
          const shrouded = !!e.darkened;   // Darkness — can't be targeted
          const sel = !dead && !shrouded && _dungeonSel.includes(e.uid);
          const isTurn = !dead && d.turn && d.turn.kind === 'enemy' && d.turn.id === e.uid;
          // Who's aiming at this monster (other humans — my own pick is the brass
          // is-sel ring). One colored ring + name per targeting human.
          const aimedBy = (!dead && d.targeting)
            ? Object.entries(d.targeting).filter(([pid, u]) => u === e.uid && pid !== meId)
                .map(([pid]) => (d.party || []).find(p => p.playerId === pid && !p.left)).filter(Boolean)
            : [];
          const shadows = aimedBy.map((p, i) => `0 0 0 ${2 + i * 3}px hsla(${aimHue(p.playerId)},85%,60%,.85)`);
          // Inline box-shadow would override the .is-turn CSS glow — fold it in.
          if (isTurn && shadows.length) shadows.unshift('0 0 12px 3px rgba(255,110,70,.65)');
          const artBg = portraitFor(e.art);   // full-art backdrop when one was paired
          const styles = [];
          if (shrouded) styles.push('opacity:.45');
          if (shadows.length) styles.push(`box-shadow:${shadows.join(', ')}`);
          if (artBg) styles.push(portraitBg(artBg).replace(/^;/, ''));
          const aimChip = aimedBy.length
            ? `<div class="dmon__aim">${aimedBy.map(p => `<span style="color:hsl(${aimHue(p.playerId)},85%,70%)">🎯${escapeText(p.nickname)}</span>`).join(' ')}</div>`
            : '';
          const pct = e.maxHp ? Math.max(0, Math.round(100 * e.hp / e.maxHp)) : 0;
          const portrait = e.art
            ? `<div class="dmon__art" style="background-image:url('${escapeAttr(e.art)}')">${e.boss ? '<span class="dmon__crown">👑</span>' : ''}</div>`
            : `<div class="dmon__glyph">${e.glyph || '❓'}${e.boss ? ' 👑' : ''}</div>`;
          return `<button type="button" class="dmon ${dead ? 'is-dead' : ''} ${sel ? 'is-sel' : ''} ${e.boss ? 'is-boss' : ''} ${isTurn ? 'is-turn' : ''} ${artBg ? 'has-portrait' : ''}"${styles.length ? ` style="${styles.join(';')}"` : ''} data-enemy="${escapeAttr(e.uid)}" ${(dead || shrouded) ? 'disabled' : ''} title="${shrouded ? 'Shrouded in darkness — cannot be targeted' : ''}">
            ${portrait}
            <div class="dmon__name">${escapeText(e.name)}${e.flying ? ` <span class="dmon__fly" title="Flying — immune to prone (can't be tripped); holds the high ground: +1 to hit and +2 AC vs grounded heroes">🪽</span>` : ''}</div>
            ${aimChip}
            ${condIcons(e.conditions)}${buffIcons(e.buffs)}
            <div class="dmon__hpbar" title="${dead ? 'Slain' : `${e.hp}/${e.maxHp} HP`}"><span style="width:${pct}%"></span></div>
            ${dead ? '<div class="dmon__hp">☠️</div>' : ''}
          </button>`;
        }).join('')
      : '<div class="dmon__none">— the room is quiet —</div>';
    // Static battlefield box: shrink the cards as the field fills so a crowded
    // room never spills past the box / pushes the spellbook off-screen. Only
    // the LIVING count — the dead collapse to tiny corpse chips (CSS .is-dead),
    // so a half-cleared room relaxes back to full-size cards.
    const _eneCompact = () => {
      if (!ene) return;
      const n = (d.enemies || []).filter(e => e.alive).length;
      ene.classList.toggle('is-compact', n > 6 && n <= 12);
      ene.classList.toggle('is-packed', n > 12);
    };
    // Villains line up left→right by initiative. They spawn fresh each room, so on
    // a newly-rolled initiative we paint them in SPAWN order for one frame, then
    // FLIP them into init order (the "settle into initiative" reveal). Within a
    // room the order is stable, so subsequent renders just re-paint sorted.
    const _enemiesSorted = [...(d.enemies || [])].sort(_byInit);
    const _eneSig = (d.status === 'combat' && _enemiesSorted.length)
      ? 'd' + d.depth + ':' + (d.enemies || []).map(e => e.uid).join(',')
      : null;
    if (ene) {
      if (_eneSig && _eneSig !== _dunEneSig) {
        ene.innerHTML = _buildEnemies([...(d.enemies || [])]);   // spawn order
        _eneCompact();
        requestAnimationFrame(() => {
          const _old = _flipCapture(ene, 'data-enemy');
          ene.innerHTML = _buildEnemies(_enemiesSorted);          // init order
          _eneCompact();
          _flipPlay(ene, 'data-enemy', _old);
        });
      } else {
        const _old = _flipCapture(ene, 'data-enemy');
        ene.innerHTML = _buildEnemies(_enemiesSorted);
        _eneCompact();
        _flipPlay(ene, 'data-enemy', _old);
      }
    }
    _dunEneSig = _eneSig;

    const party = $('#dungeonParty');
    const meInRun = (d.party || []).some(x => x.playerId === meId && !x.left);
    const _buildParty = (list) => list.map(m => {
      const pct = m.maxHp ? Math.max(0, Math.round(100 * m.hp / m.maxHp)) : 0;
      const isMe = m.playerId === meId;
      const isTurn = m.playerId === turnId;
      const cls = ['dpc']; if (pct <= 30) cls.push('is-low'); if (m.dead || m.left) cls.push('is-out'); if (m.downed) cls.push('is-down'); if (isMe) cls.push('is-me'); if (isTurn) cls.push('is-turn');
      if (_dungeonAllySel === m.playerId) cls.push('is-target');   // my buff/dispel aim
      // Full-art portrait backdrop (the hero's avatar, or their Wild Shape form).
      const heroPortrait = portraitFor((m.form && m.form.art) ? m.form.art : m.avatarId);
      if (heroPortrait) cls.push('has-portrait');
      const tag = m.dead ? ' ☠️' : m.downed ? ' 🩸' : m.left ? ' 🪜' : '';
      // HP + level only — XP-to-next moved to the blue XP bar below (saves the text
      // space). The exact "XP→next" figure rides on the XP bar's hover tooltip.
      const hpText = m.downed
        ? `${typeof m.dyingHp === 'number' ? m.dyingHp : 0}/${m.maxHp} HP · 🩸 DYING`
        : `${Math.max(0, m.hp)}/${m.maxHp} HP${m.level ? ` · Lv ${m.level}${m.maxLevel ? ' (max)' : ''}` : ''}`;
      // XP progress to next level → the blue bar under the green HP bar.
      const xpPct = m.maxLevel ? 100 : (m.xpSpan ? Math.max(0, Math.min(100, Math.round(100 * (m.xpInto || 0) / m.xpSpan))) : 0);
      const xpTitle = m.maxLevel ? 'Max level' : (typeof m.xpToNext === 'number' ? `${m.xpToNext.toLocaleString()} XP to next level` : 'Experience');
      // Auto-skip countdown badge — only on the human whose turn it is, just to
      // the right of their token. Live-ticked by the interval below.
      const afk = m.afkAt
        ? `<span class="dpc__afk" data-afk-at="${m.afkAt}" title="You'll auto-skip if idle">⏱ ${Math.max(0, Math.ceil((m.afkAt - Date.now()) / 1000))}s</span>`
        : '';
      // ⏳ pre-loaded action chip — everyone can see this player has queued their turn.
      const queuedChip = m.queued
        ? `<span class="dpc__queued" title="Pre-loaded — fires automatically the moment their turn begins">⏳ ${escapeText(m.queued)}</span>`
        : '';
      // × kick: any human delver in the run can dismiss an AI ally (same idea as
      // the poker "× kick"). Hidden for yourself, humans, and already-departed.
      const canKick = m.isBot && meInRun && !_spectating && !m.left;
      const kickHtml = canKick
        ? `<button type="button" class="dpc__remove" data-dungeon-kick="${escapeAttr(m.playerId)}" title="Dismiss ${escapeAttr(m.nickname)} from the party" aria-label="Dismiss ${escapeAttr(m.nickname)} from the party">×</button>`
        : '';
      return `<div class="${cls.join(' ')}" data-pid="${escapeAttr(m.playerId)}" style="position:relative${portraitBg(heroPortrait)}"${(!m.dead && !m.left) ? ` data-ally="${escapeAttr(m.playerId)}" title="Click to target ${escapeAttr(m.nickname)} with your next buff or dispel (click again to clear)"` : ''}>${kickHtml}
        <div class="dpc__ac" title="${escapeAttr(m.acBreak || 'Armor Class — current total')}" style="position:absolute;bottom:3px;right:5px;font-size:0.7rem;font-weight:700;color:var(--brass-bright);background:rgba(0,0,0,0.55);border-radius:6px;padding:0 5px;line-height:1.45;cursor:help;z-index:6">🛡 ${Number.isFinite(m.ac) ? m.ac : '?'}</div>
        <div class="dpc__avatar"${m.crowned ? ' style="position:relative"' : ''}>${renderAvatar((m.form && m.form.art) ? m.form.art : m.avatarId)}${m.form ? `<span class="dpc__form" title="Wild Shape: ${escapeAttr(m.form.label)}" style="position:absolute;bottom:-4px;right:-2px;font-size:1.05em;line-height:1;z-index:6;pointer-events:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.8))">${m.form.glyph || '🐾'}</span>` : ''}${m.crowned ? `<span class="dpc__crown" title="Loot Lord" style="position:absolute;top:-8px;left:50%;transform:translateX(-50%);font-size:1.05em;line-height:1;z-index:6;pointer-events:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.7))">👑</span>` : ''}</div>${afk}${queuedChip}
        <div class="dpc__name">${escapeText(m.nickname)}${isMe ? ' (you)' : ''}${m.isBot ? ' 🤖' : ''}${m.form ? ` <span class="dpc__formtag" style="color:var(--brass-bright);font-size:.82em">${escapeText(m.form.label)}</span>` : ''}${tag}</div>
        ${condIcons(m.conditions)}${buffIcons(m.buffs)}
        <div class="dpc__hpbar"><span style="width:${pct}%"></span></div>
        <div class="dpc__xpbar" title="${escapeAttr(xpTitle)}"><span style="width:${xpPct}%"></span></div>
        <div class="dpc__hp">${hpText}</div>
      </div>`;
    }).join('');
    // Heroes line up left→right by initiative too. Their cards PERSIST across
    // rooms, so they visibly SLIDE into the new order each room (no two-phase
    // needed — they're already on screen). is-compact / is-packed shrink them as
    // the party grows, exactly as before.
    const _partySorted = [...(d.party || [])].sort(_byInit);
    if (party) {
      const _old = _flipCapture(party, 'data-pid');
      party.innerHTML = _buildParty(_partySorted);
      const np = (d.party || []).filter(x => !x.dead && !x.left).length;
      party.classList.toggle('is-compact', np > 4 && np <= 6);
      party.classList.toggle('is-packed', np > 6);
      _flipPlay(party, 'data-pid', _old);
    }

    const turn = $('#dungeonTurn');
    if (turn) {
      turn.textContent =
        d.status === 'exploring' ? '🚪 The way deeper is clear — open the next door (anyone), or bail with your share.'
        : d.status === 'combat'  ? (isMyTurn ? '⚔️ Your turn — select a target, then act.' : `… ${turnName || 'the enemies'}'s turn …`)
        : '🪜 The run is over.';
    }

    const loot = $('#dungeonLoot');
    if (loot) {
      let html = '';
      // Active roll-off for a freshly-dropped magic item.
      const lr = d.lootRoll;
      if (lr) {
        const decided = lr.decided || {};
        const amEligible = (lr.eligible || []).includes(meId);
        const mine = decided[meId];
        if (amEligible && mine === undefined) {
          html += `<div class="dlootroll">
            <span class="dlootroll__head">💎 +${lr.tier} ${escapeText(lr.label)} dropped — roll for it?</span>
            <button class="btn btn--primary btn--sm" data-dact="roll">🎲 Roll d20</button>
            <button class="btn btn--ghost btn--sm" data-dact="pass">Pass</button>
          </div>`;
        } else {
          const waiting = (lr.pending || []).length;
          const mineTxt = mine === undefined ? '' : (mine === 'pass' ? ' · you passed' : ` · you rolled ${mine}`);
          html += `<div class="dlootroll dlootroll--wait">💎 +${lr.tier} ${escapeText(lr.label)} — rolling…${waiting ? ` waiting on ${waiting}` : ' resolving'}${mineTxt}</div>`;
        }
      }
      // Your own won loot drops to equip / hock.
      html += (d.pendingLoot || []).filter(l => l.owner === meId).map(l => `
        <div class="dloot">
          <span class="dloot__name">💎 +${l.tier} ${escapeText(l.label)}</span>
          <button class="btn btn--ghost btn--sm" data-loot-equip="${l.idx}">Equip</button>
          <button class="btn btn--ghost btn--sm" data-loot-hock="${l.idx}">Hock ${formatChips(l.hockValue)} gp</button>
        </div>`).join('');
      loot.innerHTML = html;
      // BLIND auto-claim: sighted players click Equip/Hock, but a blind player has no
      // pointer — so claim won loot for them. The backend equips a real upgrade or
      // hocks a redundant one for gold (never discards), and narrates the result.
      // Throttled so a render storm can't double-send, while still claiming multiple
      // drops one after another.
      if (window.BlindMode?.isOn?.()) {
        const myLoot = (d.pendingLoot || []).filter(l => l.owner === meId);
        if (myLoot.length && !d.lootRoll && (Date.now() - _dunLootClaiming > 1500)) {
          _dunLootClaiming = Date.now();
          window.BlindMode.speak(`You won the plus ${myLoot[0].tier} ${escapeText(myLoot[0].label)} — claiming it.`, 'event');   // EVENT not urgent — winning loot must not cancel the queued level-up report (Josh)
          dungeonAction('equip', { idx: myLoot[0].idx });
        }
      }
    }

    // Spectators heckle from the gallery — no combat controls, just a banner.
    const chatInput = $('#dungeonChatInput');
    if (chatInput) chatInput.placeholder = _spectating
      ? 'Heckle the delvers… (Enter to send)'
      : 'Say something to the party… (Enter to send)';

    const acts = $('#dungeonActions');
    if (acts && _spectating) {
      // Is there a live run to join, or just an empty/over dungeon to (re)start?
      const delvers = (d.party || []).filter(m => !m.left && m.hp > 0);
      const active = d.status !== 'over' && delvers.length > 0;
      const status = active
        ? `👁 Spectating ${escapeText(delvers.map(m => m.nickname).join(', '))} — you can heckle in chat below.`
        : `👁 The dungeon is quiet — no one is delving right now.`;
      const actionBtn = active
        ? `<button class="btn btn--primary btn--sm" data-dact="join" title="Leave your poker seat and join the delve">⚔️ Join the delve</button>`
        : `<button class="btn btn--primary btn--sm" data-dact="join" title="Leave your poker seat and kick off a fresh dungeon run">🗡️ Start Dungeon</button>`;
      acts.innerHTML =
        `<div class="dungeon__actstatus dungeon__spectating">${status}</div>` +
        `<div class="dungeon__actrow">` +
          actionBtn +
          `<button class="btn btn--ghost btn--sm" data-dact="leave">↩ Back to the table</button>` +
        `</div>`;
    } else if (acts) {
      const me = (d.party || []).find(m => m.playerId === meId) || {};
      if (d.status === 'over') {
        acts.innerHTML = `<div class="dungeon__actstatus">The run is over.</div>` +
          `<div class="dungeon__actrow"><button class="btn btn--primary" data-dact="leave">↩ Back to the table</button></div>`;
      } else {
        const combat = d.status === 'combat';
        const myTurn = combat && isMyTurn;
        // Players can OPEN their spellbook any time (to read what they have) — the
        // spell tiles themselves stay disabled until their turn, so it's view-only
        // off-turn. It's still freely closeable (the toggle, an outside click, or
        // Escape), so an open popover never soft-locks the action bar.
        const rolling = !!d.lootRoll;
        const B = (act, label, on, primary) =>
          `<button class="btn ${primary ? 'btn--primary' : 'btn--ghost'}" data-dact="${act}"${on ? '' : ' disabled'}>${label}</button>`;
        const kit = me.kit || { atwill: { name: 'Attack', icon: '⚔️' }, abilities: [], spellPool: null };
        // An ability's glyph: its art icon if present, else its emoji.
        const ic = (ab) => ab.img ? `<img class="spell-ic" src="${escapeAttr(ab.img)}" alt="" />` : `${ab.icon || ''} `;
        // A single ability/spell button. Level-locked → greyed 🔒. 'pool' spells
        // draw from the shared cast pool; 'room' abilities show their own count;
        // 'free' maneuvers are always on (your turn).
        const abilBtn = (ab, slot) => {
          if (!ab.available) {
            return `<button class="btn btn--ghost" disabled title="${escapeAttr(ab.desc || '')}\n(unlocks at level ${ab.minLevel})">🔒 ${ic(ab)}${escapeText(ab.name)} <span class="dungeon__uses">Lv${ab.minLevel}</span></button>`;
          }
          // An active Wild Shape form stays clickable (to revert) even at 0 uses.
          const ok = ab.active ? true : (ab.cost === 'free' ? true : (ab.remaining > 0));
          const count = (ab.cost === 'room' || ab.cost === 'run')
            ? ` <span class="dungeon__uses" title="${ab.cost === 'run' ? 'once per dungeon' : 'per room'}">${ab.remaining}/${ab.max}</span>` : '';
          const tgt = ab.maxTargets > 1 ? ` <span class="dungeon__uses">×${ab.maxTargets}</span>` : '';
          const cls = ab.active ? 'btn btn--primary' : 'btn btn--ghost';
          const mark = ab.active ? '✓ ' : '';
          let ttl = ab.active ? `${ab.desc || ''}\n(active — click to revert to normal)` : (ab.desc || '');
          if (combat && !myTurn) ttl += '\n(⏳ not your turn — clicking QUEUES it to fire the moment your turn begins)';
          // CHANNEL — offensive vs defensive: two buttons sharing the slot + use pool
          // (Tobias). Heal mends the party; Sear blasts the undead instead.
          if (ab.modePick) {
            const dis = (combat && ok) ? '' : ' disabled';
            const a = `${ab.key || ''}`;
            return `<button class="${cls}" data-dact="ability" data-slot="${slot}" data-abkey="${escapeAttr(a)}" data-mode="defensive"${dis} title="${escapeAttr(ttl)}\nHeal the whole party.">${mark}💖 ${escapeText(ab.name)}: Heal${count}</button>`
                 + `<button class="btn btn--ghost" data-dact="ability" data-slot="${slot}" data-abkey="${escapeAttr(a)}" data-mode="offensive"${dis} title="Channel offensively — SEAR the undead instead of healing.">🔥 ${escapeText(ab.name)}: Sear${count}</button>`;
          }
          return `<button class="${cls}" data-dact="ability" data-slot="${slot}" data-abkey="${escapeAttr(ab.key || '')}"${(combat && ok) ? '' : ' disabled'} title="${escapeAttr(ttl)}">${mark}${ic(ab)}${escapeText(ab.name)}${tgt}${count}</button>`;
        };
        // Spellbook tile: icon ONLY (name + short description show on hover).
        // A corner badge carries the uses-left count, or 🔒 when level-locked.
        const spellIcon = (ab, slot) => {
          const locked = !ab.available;
          const ok = !locked && (ab.cost === 'free' ? true : (ab.remaining > 0));
          const dis = !combat || !ok;   // off-turn casts QUEUE (fire at turn start); view-only while exploring
          const cnt = (ab.cost === 'room' || ab.cost === 'run') && ab.max ? `${ab.remaining}/${ab.max}` : '';
          const badge = locked ? `<span class="dungeon__sb-badge dungeon__sb-lock">🔒</span>`
                      : (cnt ? `<span class="dungeon__sb-badge">${cnt}</span>` : '');
          const tgt = ab.maxTargets > 1 ? ` · up to ${ab.maxTargets} foes` : '';
          const lk  = locked ? ` — unlocks at level ${ab.minLevel}` : '';
          // Metamagic active → this slot spell draws a HIGHER slot; show which.
          const mmSlot = (ab.cost === 'slot' && ab.slvlEff && ab.slvlEff !== ab.slvl) ? ` — METAMAGIC: draws a ${ab.slvlEff}th-level slot` : '';
          const title = `${ab.name}${tgt}${lk}${mmSlot}${ab.desc ? ' — ' + ab.desc : ''}`;
          return `<button class="dungeon__sb-spell${locked ? ' is-locked' : ''}" data-dact="ability" data-slot="${slot}"${dis ? ' disabled' : ''} title="${escapeAttr(title)}" aria-label="${escapeAttr(ab.name)}">${ic(ab)}${badge}</button>`;
        };
        const atName = `${kit.atwill.img ? ic(kit.atwill) : (kit.atwill.icon || '⚔️') + ' '}${escapeText(kit.atwill.name || 'Attack')}`;
        const pool = kit.spellPool ? ` · ✨ ${kit.spellPool.remaining}/${kit.spellPool.max} casts` : '';
        const status = combat
          ? (myTurn ? `⚔️ Your turn${pool}` : `${turnName ? escapeText(turnName) + ' is acting…' : 'Enemies acting…'} <span class="dungeon__queuehint" title="Pick an action now and it pre-loads — it fires automatically the moment your turn begins. Picking another replaces it.">⏳ clicks queue for your turn</span>`)
          : '🚪 Pick a door — or bail.';
        // Casters collapse their spells into an expandable Spellbook ▾; everyone
        // else shows their maneuvers inline. The badge/header differ by caster:
        // cleric shows a shared cast pool; wizard/sorcerer show their own note
        // ("one cast of each spell per room" / "cast freely").
        let abilHtml;
        if (kit.caster) {
          const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
          // Class FEATURES (no spell level — bardic performance, Channel…) show as
          // inline buttons; SPELLS (with a spell level) live in the Spellbook ▾,
          // grouped by level. Keep each ability's ORIGINAL index for data-slot.
          const features = [], spellsByLvl = new Map();
          (kit.abilities || []).forEach((ab, i) => {
            const sl = ab.slot != null ? ab.slot : i;   // server-provided stable index (survives char filtering)
            if (ab.slvl == null) { features.push({ ab, i: sl }); return; }
            if (!spellsByLvl.has(ab.slvl)) spellsByLvl.set(ab.slvl, []);
            spellsByLvl.get(ab.slvl).push(spellIcon(ab, sl));
          });
          const sections = [...spellsByLvl.keys()].sort((a, b) => a - b).map(k => {
            const sl = kit.slots && kit.slots[k];   // spontaneous: per-level slot count
            const slotTxt = sl ? ` <span class="dungeon__sb-slots">${sl.remaining}/${sl.max} slots</span>` : '';
            return `<div class="dungeon__sb-lvl">` +
              `<div class="dungeon__sb-lvlhead">${ord(k)}-Level${slotTxt}</div>` +
              `<div class="dungeon__sb-row">${spellsByLvl.get(k).join('')}</div>` +
            `</div>`;
          }).join('');
          // Slot summary (spontaneous) → e.g. "1st:6 2nd:5 3rd:3"; cleric shows its pool.
          const slotSummary = kit.slots ? Object.keys(kit.slots).sort((a, b) => a - b).map(L => `${ord(+L)}:${kit.slots[L].remaining}`).join(' ') : '';
          const badge = kit.spellPool ? ` <span class="dungeon__uses">✨${kit.spellPool.remaining}/${kit.spellPool.max}</span>`
                      : (kit.slots ? ` <span class="dungeon__uses">✨${slotSummary}</span>` : '');
          const head  = kit.slots ? `✨ Spell slots — ${slotSummary}`
                      : (kit.spellPool ? `✨ ${kit.spellPool.remaining}/${kit.spellPool.max} casts left this room` : (kit.spellNote || 'Spells'));
          const featureBtns = features.map(({ ab, i }) => abilBtn(ab, i)).join('');
          // Wrap the toggle + popover so the popover anchors to the BUTTON (drops
          // straight down-and-right from it), not to the whole action panel.
          abilHtml =
            featureBtns +
            `<span class="dungeon__sb-wrap">` +
              `<button type="button" class="btn ${_spellbookOpen ? 'btn--primary' : 'btn--ghost'}" data-spellbook-toggle aria-expanded="${_spellbookOpen}">📖 Spellbook ▾${badge}</button>` +
              `<div class="dungeon__spellbook ${_spellbookOpen ? 'is-open' : ''}">` +
                `<div class="dungeon__sb-head">${escapeText(head)}</div>` +
                `<div class="dungeon__sb-scroll">${sections}</div>` +
              `</div>` +
            `</span>`;
        } else {
          abilHtml = (kit.abilities || []).map((ab, i) => abilBtn(ab, ab.slot != null ? ab.slot : i)).join('');
        }
        acts.innerHTML =
          `<div class="dungeon__actstatus">${status}</div>` +
          // Two labelled groups (with screen-reader headings) so a blind player can
          // jump by heading and tab through each set on its own: the combat/play
          // actions, then the navigation/session controls.
          `<div class="dungeon__actrow dungeon__actrow--abilities" role="group" aria-label="Combat actions">` +
            `<h2 class="sr-only">Combat actions</h2>` +
            B('attack', atName, combat, combat) +   // off-turn click queues the attack
            // Caster cantrip ELEMENT selector (cold/acid/electricity, + the class's
            // own if distinct) — free, clickable any time, current pick highlighted.
            // Blind: the C key cycles the same choices.
            (me.cantrip ? `<span class="dungeon__cantrips" role="group" aria-label="At-will cantrip element (C cycles)">` +
              me.cantrip.choices.map(c =>
                `<button class="btn ${c.key === me.cantrip.current ? 'btn--primary' : 'btn--ghost'}" data-dact="cantrip" data-cankey="${escapeAttr(c.key)}" aria-pressed="${c.key === me.cantrip.current}" title="${escapeAttr(c.name)} — your at-will ray deals ${escapeAttr(c.dtype)} (free to switch, any time)">${c.icon}</button>`
              ).join('') + `</span>` : '') +
            // Spontaneous-caster METAMAGIC toggles (one per feat owned). Toggling on
            // raises your next damaging spell's slot cost and boosts it; stacking is
            // allowed. Lit = active.
            ((kit.metamagic && kit.metamagic.length) ? `<span class="dungeon__metamagic" role="group" aria-label="Metamagic — toggle before casting">` +
              kit.metamagic.map(mm =>
                `<button class="btn ${mm.on ? 'btn--primary' : 'btn--ghost'} btn--sm" data-dact="metamagic" data-mmkey="${escapeAttr(mm.key)}" aria-pressed="${!!mm.on}" title="${escapeAttr(mm.name)} (${mm.adj} slot level) — toggle before you cast; stacks with others">✨${escapeText(mm.name)} ${mm.adj}</button>`
              ).join('') + `</span>` : '') +
            abilHtml +
          `</div>` +
          `<div class="dungeon__actrow dungeon__actrow--nav" role="group" aria-label="Navigation and session controls">` +
            `<h2 class="sr-only">Navigation and session controls</h2>` +
            B('door', '🚪 Open door', !combat && !rolling, !combat) +
            `<button class="btn btn--ghost" data-dact="spectate" title="Bank your gold and leave the fight — but keep watching from the sidelines">👁 Spectate</button>` +
            `<button class="btn btn--ghost" data-dact="leave" title="Bank your gold and go back to the poker table">↩ Leave dungeon</button>` +
            `<button class="btn btn--ghost" data-dact="cancel" title="End the whole run for everyone — all delvers bank their share and return upstairs">🛑 Cancel run</button>` +
          `</div>`;
      }
    }

    // Recruit panel — unseated AI bots you can bring along (50g each). Uses
    // the same card style as the poker "Pick AI" picker.
    const recruit = $('#dungeonRecruit');
    if (recruit) {
      const list = d.recruitable || [];
      const full = (d.botCount || 0) >= 3;
      // "↻ Last party": this browser's remembered crew from the previous run —
      // only offered when every remembered ally is currently recruitable.
      const _lastDun = (() => { try { return JSON.parse(localStorage.getItem('fp_lastDunParty') || '[]'); } catch (_) { return []; } })();
      const lastCards = _lastDun.map(id => list.find(b => b.playerId === id)).filter(Boolean);
      const lastFee = lastCards.reduce((s, b) => s + (b.fee || 0), 0);
      const lastBtn = lastCards.length
        ? `<button type="button" class="btn btn--ghost btn--sm dungeon__recruit-last" data-recruit-last ${full ? 'disabled' : ''} title="Recruit the same crew as last run — ${escapeAttr(lastCards.map(b => `${b.nickname} (${b.cls})`).join(', '))} — ${lastFee}g total">↻ Last party (${lastCards.length}) · ${lastFee}g</button>`
        : '';
      if (d.status === 'over' || !list.length || _spectating) { recruit.innerHTML = ''; _recruitOpen = false; }
      else recruit.innerHTML =
        `<button type="button" class="btn btn--ghost btn--sm dungeon__recruit-toggle" data-recruit-toggle aria-expanded="${_recruitOpen}">🤝 Recruit AI ▾ <span class="dungeon__recruit-count">${list.length}</span></button>` +
        lastBtn +
        `<button type="button" class="btn btn--ghost btn--sm dungeon__recruit-random" data-recruit-random ${full ? 'disabled' : ''} title="Hire up to 3 random allies — fee scales with each ally's level (50g + 10g/level)">🎲 Random helpers</button>` +
        `<div class="dungeon__recruit-pop ${_recruitOpen ? 'is-open' : ''}">` +
          `<div class="dungeon__recruit-head">Unseated allies — 50g + 10g per level${full ? ' · party full' : ''}</div>` +
          `<div class="bot-picker__grid bot-picker__grid--dungeon">` +
          list.map(b => `<button type="button" class="bot-picker__card" data-recruit="${escapeAttr(b.playerId)}" ${full ? 'disabled' : ''} title="${escapeAttr(b.nickname)}, ${escapeAttr(b.cls || '')} — ${escapeAttr(dungeonGearTip(b.gear))} · 💰 ${formatChips(b.wealth)} gp · recruit for ${b.fee}g">
              <div class="bot-picker__avatar">${renderAvatar(b.avatarId)}</div>
              <div class="bot-picker__nick">${escapeText(b.nickname)}</div>
              <div class="bot-picker__worth">${escapeText(b.cls || '')} · 🤝 ${b.fee}g</div>
            </button>`).join('') +
          `</div>` +
        `</div>`;
    }

    // Two independent panes: party (hero + run/loot/chat) on the left, monsters
    // on the right, each scrolling on its own. Newest-first; we only snap a pane
    // back to the top when it was already near the top, so a player reading
    // earlier events isn't yanked away mid-fight. `side`/`kind` come from the
    // server (fall back to text sniffing for older entries).
    const heroLog = $('#dungeonLogHero'), enemyLog = $('#dungeonLogEnemy');
    if (heroLog && enemyLog) {
      const row = e => {
        const txt = e.text || '';
        const say = txt.startsWith('💬');
        const kind = e.kind || 'normal';
        const body = escapeText(txt).replace(/d20 (\d+)/g, 'd20 <b class="droll">$1</b>');
        return `<li><span class="dlog__b dlog-k--${kind}${say ? ' dlog-say' : ''}">${body}</span></li>`;
      };
      const sideOf = e => e.side || ((e.text || '').startsWith('💬') ? 'system' : 'hero');
      const all = (d.log || []).slice().reverse();
      const paint = (el, html) => {
        const atTop = el.scrollTop < 24;
        el.innerHTML = html;
        if (atTop) el.scrollTop = 0;
      };
      paint(heroLog,  all.filter(e => sideOf(e) !== 'enemy').map(row).join(''));
      paint(enemyLog, all.filter(e => sideOf(e) === 'enemy').map(row).join(''));
    }
  }

  // ---- Dungeon UI wiring (delegated; elements are static in index.html) ----
  // "Hit the Dungeon" lives in the money dropdown (#mePursePop), which is
  // re-rendered each paintMe — so delegate the click.
  $('#mePursePop')?.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-enter-dungeon]')) enterDungeon();
    else if (ev.target.closest('[data-spectate-dungeon]')) spectateDungeon();
  });
  $('#dungeonLeaveBtn')?.addEventListener('click', returnFromDungeon);
  // × kick on an AI party member — dismiss them from the dungeon run.
  $('#dungeonParty')?.addEventListener('click', (ev) => {
    const k = ev.target.closest?.('[data-dungeon-kick]');
    if (k) {
      ev.preventDefault();
      socket.emit('dungeon:kick', { botId: k.dataset.dungeonKick }, (resp) => {
        if (!resp?.ok) toast(resp?.error || 'Could not dismiss ally', true);
      });
      return;
    }
    // Click a party card to TARGET an ally — buffs / dispels aim at them
    // (invalid picks are refused with a reason; no pick = smart auto-cast).
    // Click again to deselect.
    const card = ev.target.closest?.('[data-ally]');
    if (!card) return;
    const pid = card.dataset.ally;
    _dungeonAllySel = (_dungeonAllySel === pid) ? null : pid;
    renderDungeon();
  });
  $('#dungeonEnemies')?.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-enemy]'); if (!b) return;
    const uid = b.dataset.enemy;
    const i = _dungeonSel.indexOf(uid);
    if (i >= 0) _dungeonSel.splice(i, 1);
    else { _dungeonSel.push(uid); if (_dungeonSel.length > 2) _dungeonSel.shift(); }
    emitAim(_dungeonSel[0] || null);   // telegraph the pick to the party
    renderDungeon();
  });
  $('#dungeonActions')?.addEventListener('click', (ev) => {
    // Spellbook expand/collapse (caster classes).
    if (ev.target.closest('[data-spellbook-toggle]')) { _spellbookOpen = !_spellbookOpen; renderDungeon(); return; }
    const b = ev.target.closest('[data-dact]'); if (!b || b.disabled) return;
    const act = b.dataset.dact;
    if (act === 'attack')       dungeonAction('attack', { targetUid: _dungeonSel[0] });
    else if (act === 'ability') {
      const payload = { slot: Number(b.dataset.slot) || 0, targetUid: _dungeonSel[0], targetUids: _dungeonSel.slice(0, 6), allyUid: _dungeonAllySel || undefined, mode: b.dataset.mode || undefined };
      // Inquisitor Bane declares a creature TYPE: take it from the selected foe
      // (if any). With nothing selected the server auto-picks the commonest type.
      if (b.dataset.abkey === 'bane') {
        const sel = (state.dungeon?.enemies || []).find(e => e.uid === _dungeonSel[0] && e.alive);
        if (sel && sel.type) payload.baneType = sel.type;
      }
      dungeonAction('ability', payload); _spellbookOpen = false;
    }
    else if (act === 'cantrip') dungeonAction('cantrip', { key: b.dataset.cankey });   // switch at-will element — free, any time
    else if (act === 'metamagic') dungeonAction('metamagic', { key: b.dataset.mmkey });   // toggle a metamagic on/off (spontaneous casters)
    else if (act === 'door')    dungeonAction('door');
    else if (act === 'bail')    dungeonAction('bail');
    else if (act === 'join')    enterDungeon();        // spectator → combatant
    else if (act === 'spectate') bailToSpectate();     // combatant → spectator (keeps watching)
    else if (act === 'leave')   returnFromDungeon();   // self bails + back to table
    else if (act === 'cancel')  cancelDungeon();       // force-end the whole run
    if (act === 'attack' || act === 'ability') _dungeonSel = [];
  });
  // The Spellbook is a popover that overlays the other action buttons, so it
  // must always be dismissable: a click anywhere outside its wrap — or Escape —
  // closes it. (This is what keeps an open popover from soft-locking the action
  // bar now that it can stay open off-turn for viewing.)
  document.addEventListener('click', (ev) => {
    if (!_spellbookOpen || document.body.dataset.screen !== 'dungeon') return;
    if (ev.target.closest('.dungeon__sb-wrap')) return;   // inside the spellbook/toggle — keep it
    _spellbookOpen = false;
    renderDungeon();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && _spellbookOpen && document.body.dataset.screen === 'dungeon') {
      _spellbookOpen = false;
      renderDungeon();
    }
  });
  // The recruit picker now centers on screen (modal-like with a dim backdrop), so
  // it must be dismissable by clicking outside it or pressing Escape.
  const closeRecruit = () => {
    _recruitOpen = false;
    const pop = $('#dungeonRecruit')?.querySelector('.dungeon__recruit-pop');
    if (pop) pop.classList.remove('is-open');
    const tog = $('#dungeonRecruit')?.querySelector('[data-recruit-toggle]');
    if (tog) tog.setAttribute('aria-expanded', 'false');
  };
  document.addEventListener('click', (ev) => {
    if (!_recruitOpen || document.body.dataset.screen !== 'dungeon') return;
    if (ev.target.closest('.dungeon__recruit')) return;   // inside the panel/popover/toggle — keep it
    closeRecruit();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && _recruitOpen && document.body.dataset.screen === 'dungeon') closeRecruit();
  });
  $('#dungeonRecruit')?.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-recruit-toggle]')) {
      _recruitOpen = !_recruitOpen;
      const pop = $('#dungeonRecruit')?.querySelector('.dungeon__recruit-pop');
      if (pop) pop.classList.toggle('is-open', _recruitOpen);
      const tog = $('#dungeonRecruit')?.querySelector('[data-recruit-toggle]');
      if (tog) tog.setAttribute('aria-expanded', String(_recruitOpen));
      return;
    }
    if (ev.target.closest('[data-recruit-random]')) {
      socket.emit('dungeon:recruitRandom', null, (resp) => {
        if (!resp?.ok) { toast(resp?.error || 'Could not hire helpers', true); return; }
        toast(`🎲 Hired ${resp.hired} random ${resp.hired === 1 ? 'helper' : 'helpers'} (50g each).`);
      });
      return;
    }
    if (ev.target.closest('[data-recruit-last]')) {
      let ids = []; try { ids = JSON.parse(localStorage.getItem('fp_lastDunParty') || '[]'); } catch (_) {}
      if (!ids.length) { toast('No remembered party yet — finish a run with allies first.', true); return; }
      // Hire one at a time (chained acks) so each fee debits before the next check.
      const hire = (i, ok) => {
        if (i >= ids.length) { toast(ok ? `↻ Recruited ${ok} of ${ids.length} from your last party.` : 'Could not recruit your last party.', !ok); return; }
        socket.emit('dungeon:recruit', { botId: ids[i] }, (resp) => hire(i + 1, ok + (resp && resp.ok ? 1 : 0)));
      };
      hire(0, 0);
      return;
    }
    const b = ev.target.closest('[data-recruit]'); if (!b) return;
    socket.emit('dungeon:recruit', { botId: b.dataset.recruit }, (resp) => {
      if (resp && resp.ok === false) toast(resp.error || 'Could not recruit', true);
    });
  });
  // Dungeon party chat — mirrors the poker chat form. The message round-trips
  // through dungeon:say and shows up in everyone's log via the state broadcast.
  $('#dungeonChatForm')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('#dungeonChatInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    socket.emit('dungeon:say', { text }, (resp) => {
      if (resp?.ok) {
        input.value = '';
        // Blind players land back in combat after talking — Backslash brought them
        // here, a sent message bounces them out so the dungeon hotkeys work again.
        if (window.BlindMode?.isOn?.()) { try { input.blur(); } catch (_) {} window.BlindMode.speak('Message sent.', 'urgent'); }
      } else toast(resp?.error || 'Could not send', true);
    });
  });
  // Escape inside the message field = bail back to the dungeon without sending
  // (blind players use Backslash to enter, Escape to leave). The dungeon keydown
  // handler bails while an INPUT is focused, so this is the only listener that sees it.
  $('#dungeonChatInput')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.target.value = '';
      try { ev.target.blur(); } catch (_) {}
      if (window.BlindMode?.isOn?.()) window.BlindMode.speak('Cancelled. Back to the dungeon.', 'urgent');
    }
  });
  $('#dungeonLoot')?.addEventListener('click', (ev) => {
    const dr = ev.target.closest('[data-dact]');
    if (dr) { const a = dr.dataset.dact; if (a === 'roll') dungeonAction('lootroll', { roll: true }); else if (a === 'pass') dungeonAction('lootroll', { roll: false }); return; }
    const eq = ev.target.closest('[data-loot-equip]');
    const ho = ev.target.closest('[data-loot-hock]');
    if (eq) dungeonAction('equip', { idx: Number(eq.dataset.lootEquip) });
    else if (ho) dungeonAction('hock', { idx: Number(ho.dataset.lootHock) });
  });
  // Keyboard play on the dungeon screen (mouse-free; aids blind players):
  //   1-9 target an enemy · A attack · L lightning · S stink · O/Enter door · B bail
  document.addEventListener('keydown', (e) => {
    if (document.body.dataset.screen !== 'dungeon') return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const d = state.dungeon; if (!d) return;
    const k = (e.key || '').toLowerCase();
    // ----- Blind keyboard play (only when blind mode is on; the sighted scheme
    //       below never runs in blind mode — the branch ends with a hard return).
    //       1 = Attack, 2..N = abilities, 0 = open door (row or numpad), B = bail,
    //       . = cancel run (confirm), ? = help mode (speak keys without firing). -----
    if (window.BlindMode?.isOn?.()) {
      if (e.key !== '.') _dunCancelArm = 0;   // any non-"." key aborts a pending cancel-run confirm
      if (e.key === '?') { e.preventDefault(); _blindHelp = !_blindHelp; window.BlindMode.speak(`Help mode ${_blindHelp ? 'on' : 'off'}.`, 'urgent'); return; }
      const sayU = (t) => window.BlindMode.speak(t, 'urgent');
      // Backslash = jump INTO the dungeon message field. A blind player can't mouse
      // over to the chat box mid-combat (Josh, playing with Harry over dungeon
      // messaging), so this drops focus straight into it: type, Enter sends and
      // bounces you back to combat, Escape cancels. (\\ is otherwise unused in the
      // dungeon, and the INPUT-focus guard above means it never fires combat keys.)
      if (e.key === '\\') {
        e.preventDefault();
        if (_blindHelp) { sayU('Backslash: open the message field to type to the party. Enter sends, Escape cancels.'); return; }
        const input = document.getElementById('dungeonChatInput');
        if (!input) { sayU('No message field here.'); return; }
        input.focus(); try { input.select(); } catch (_) {}
        sayU('Message field. Type your message, Enter to send, Escape to cancel.');
        return;
      }
      // Order foes by CR (highest threat first) for blind enumeration + targeting,
      // so "enemy 1" is always the most dangerous. Handles fractional CRs ("1/3").
      const crNum = (cr) => { const s = String(cr ?? ''); if (s.includes('/')) { const p = s.split('/'); const a = parseFloat(p[0]), b = parseFloat(p[1]); return b ? a / b : 0; } const n = parseFloat(s); return Number.isFinite(n) ? n : 0; };
      const byCr = (a, b) => crNum(b.cr) - crNum(a.cr);
      const aliveE = (d.enemies || []).filter(x => x.alive).sort(byCr);
      const enemyDesc = (en, i) => {
        const c = (en.conditions || []).map(x => String(x.label || '').toLowerCase()).filter(Boolean);
        let s = `${i + 1}: ${en.name}, ${Math.max(0, en.hp | 0)} of ${en.maxHp | 0} HP`;
        if (en.flying) s += ', flying';
        if (en.boss) s += ', boss';
        if (en.drDesc) s += `, ${en.drDesc}`;   // e.g. "DR 15/bludgeoning — slashing glances off" (why hits run low)
        if (c.length) s += ', ' + c.join(', ');
        return s;
      };
      const meId = state.me?.player_id;
      const meM = (d.party || []).find(m => m.playerId === meId) || {};
      const kit = meM.kit || { atwill: { name: 'Attack' }, abilities: [] };
      const myTurn = d.status === 'combat' && d.turn && d.turn.kind === 'party' && d.turn.id === meId;
      // ----- Metamagic menu (G) — blind access to the metamagic toggles -------
      // A spontaneous caster (e.g. Olbryn) toggles metamagic feats before casting.
      // Blind players had no way to reach the on-screen toggle buttons (Josh, L20
      // sorcerer). G opens/closes a little menu; while it's open a number toggles
      // that feat on/off. The toggles re-level the next damaging spell, same as the UI.
      const _mm = kit.metamagic || [];
      if (_dunMmMenu) {
        if (e.key === 'Escape') { e.preventDefault(); _dunMmMenu = null; sayU('Metamagic menu closed.'); return; }
        if (/^[1-9]$/.test(k)) {
          e.preventDefault();
          const mm = _dunMmMenu[parseInt(k, 10) - 1];
          if (!mm) { sayU(`No metamagic ${k}.`); return; }
          dungeonAction('metamagic', { key: mm.key });
          mm.on = !mm.on;   // keep the captured menu in sync so repeat toggles stay accurate
          sayU(`${mm.name} ${mm.on ? 'on' : 'off'}.`);
          return;
        }
      }
      if (k === 'g') {
        e.preventDefault();
        if (_blindHelp) { sayU('G: metamagic. If you have metamagic feats, press G then a number to toggle one on or off before you cast.'); return; }
        if (!_mm.length) { sayU('You have no metamagic feats.'); return; }
        if (_dunMmMenu) { _dunMmMenu = null; sayU('Metamagic menu closed.'); return; }
        _dunMmMenu = _mm.map(x => ({ ...x }));
        sayU('Metamagic: ' + _dunMmMenu.map((x, i) => `${i + 1} ${x.name} ${x.on ? 'on' : 'off'}`).join(', ') + '. Press a number to toggle, Escape to close.');
        return;
      }
      // ----- Blind action list -----------------------------------------------
      // 1 = Attack, then each class FEATURE (no spell level), then a single
      // "Spellbook" entry for casters. Spells are NOT individually numbered —
      // they're reached by opening the spellbook and picking a spell LEVEL.
      const ord = (nn) => { const s = ['th', 'st', 'nd', 'rd'], v = nn % 100; return nn + (s[(v - 20) % 10] || s[v] || s[0]); };
      const spells = (kit.abilities || []).filter(a => a.slvl != null);
      const hasSpellbook = !!kit.caster && spells.length > 0;
      const spellLevels = [...new Set(spells.map(s => s.slvl))].sort((a, b) => a - b);
      const blindActions = [{ kind: 'attack', label: kit.atwill?.name || 'Attack' }];
      (kit.abilities || []).forEach((ab, i) => {   // class FEATURES only (spells live in the spellbook)
        if (ab.slvl != null) return;
        blindActions.push({ kind: 'ability', ab, slot: (ab.slot != null ? ab.slot : i), label: ab.name });
      });
      if (hasSpellbook) blindActions.push({ kind: 'spellbook', label: 'Spellbook' });
      // Fire a spell with sensible auto-targeting: single-enemy spells hit your
      // locked target (or the deadliest foe); AoE hits everything; self/ally let
      // the server pick (e.g. healing finds the lowest-HP ally).
      const castSpell = (ab) => {
        if (!myTurn) { window.BlindMode.speak('Not your turn.', 'ambient'); return; }   // hard gate; AMBIENT so it can't cut off the end-of-room report (Josh)
        const slot = (ab.slot != null ? ab.slot : 0);
        if (ab.target === 'enemy') {
          // Single-target enemy spells (Suffocation, Hold Person, Disintegrate,
          // Searing Ray…) let you AIM at a specific foe — Josh wasted a Suffocate
          // on a lich because it auto-locked the deadliest. Prompt to pick when
          // 2+ foes are up. Magic Missile & other auto-hit spells (effect
          // 'missile') keep snapping to the deadliest, as Josh prefers.
          if (ab.effect !== 'missile' && aliveE.length > 1) {
            _dunTarget = { kind: 'ability', slot, label: ab.name };
            const list = aliveE.slice(0, 9).map((x, i) => `${i + 1}, ${x.name}${x.flying ? ', flying' : ''}${x.cr ? `, CR ${x.cr}` : ''}, ${Math.max(0, x.hp | 0)} HP`).join('; ');
            sayU(`${ab.name} — select a target, deadliest first: ${list}.`);
            return;
          }
          const locked = _dunQueuedAttack && aliveE.find(x => x.uid === _dunQueuedAttack);
          const tgt = locked || aliveE[0];
          dungeonAction('ability', { slot, targetUid: tgt?.uid, targetUids: tgt ? [tgt.uid] : [] });
        } else if (ab.target === 'aoe') {
          dungeonAction('ability', { slot, targetUid: aliveE[0]?.uid, targetUids: aliveE.slice(0, 6).map(x => x.uid) });
        } else if (ab.allyPick) {
          // Aimed at a CHOSEN ally (Josh: hide Vaughn, not always Nomkath). Prompt
          // for one — numbers pick a party member, Return takes the smart auto-pick.
          const party = (d.party || []).filter(p => !p.left && !p.dead);
          const allies = party.map(p => p.playerId);
          _dunAllyPick = { slot, label: ab.name, allies };
          const list = party.map((p, i) => `${i + 1} ${p.nickname}${p.playerId === meId ? ', you' : ''}`).join(', ');
          sayU(`${ab.name} on whom? ${list}. Press a number, or Return for the best target.`);
        } else if (ab.dispelPick) {
          // Dispel Magic — pick an afflicted ALLY (strip a debuff) or an enchanted
          // FOE (strip a buff). Numbers pick; Return = smart auto. If the client
          // sees no candidate, let the server decide (it sees boss wards too) — it
          // auto-casts or refuses + speaks "nothing to dispel".
          const CC = ['held', 'paralyzed', 'slowed', 'grappled', 'blinded', 'sickened', 'stunned'];
          const allies = (d.party || []).filter(p => !p.left && !p.dead && (p.conditions || []).some(c => CC.includes(c.key)));
          const foes = aliveE.filter(e => (e.buffs || []).length);
          const targets = allies.map(p => ({ kind: 'ally', id: p.playerId, name: p.nickname }))
                       .concat(foes.map(e => ({ kind: 'foe', id: e.uid, name: e.name })));
          if (!targets.length) { dungeonAction('ability', { slot }); return; }   // server auto/refuses
          _dunDispelPick = { slot, label: ab.name, targets };
          const list = targets.map((t, i) => `${i + 1} ${t.name}${t.kind === 'ally' ? ' (cleanse)' : ' (strip)'}`).join(', ');
          sayU(`${ab.name} on whom? ${list}. Press a number, or Return for the best target.`);
        } else if (ab.modePick) {
          // Channel: 1 = heal the party (defensive), 2 = sear the undead (offensive),
          // Return = the smart auto-pick (heal if anyone's hurt, else sear undead).
          _dunModePick = { slot, label: ab.name };
          sayU(`${ab.name}: press 1 to heal the party, 2 to sear the undead, or Return for the smart choice.`);
        } else {
          dungeonAction('ability', { slot });   // self / ally — server chooses
        }
      };
      // ----- Spellbook sub-mode ----------------------------------------------
      // Active once the player opens the spellbook. Numbers pick a spell LEVEL,
      // Tab cycles the spells at that level (spoken by name), Return casts the
      // focused spell and closes the book, Escape backs out.
      const closeSb = () => {
        _dunSbMode = false; _dunSbLevel = null; _dunSbIdx = -1; _spellbookOpen = false;
        if (document.body.dataset.screen === 'dungeon') renderDungeon();
      };
      if (_dunSbMode) {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (_dunSbLevel != null) { _dunSbLevel = null; _dunSbIdx = -1; sayU(`Spellbook. Levels: ${spellLevels.map(ord).join(', ')}. Pick a level, or Escape to close.`); }
          else { closeSb(); sayU('Spellbook closed.'); }
          return;
        }
        if (/^[1-9]$/.test(k)) {
          e.preventDefault();
          const lvl = parseInt(k, 10);
          const at = spells.filter(s => s.slvl === lvl);
          if (!at.length) { sayU(`No level ${ord(lvl)} spells.`); return; }
          _dunSbLevel = lvl; _dunSbIdx = -1;
          const names = at.map(s => s.name).join(', ');
          sayU(`${ord(lvl)} level: ${names}. Tab through spells, Return to cast.`);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          if (_dunSbLevel == null) { sayU(`Pick a spell level first: ${spellLevels.map(ord).join(', ')}.`); return; }
          const at = spells.filter(s => s.slvl === _dunSbLevel);
          if (!at.length) { sayU('No spells at this level.'); return; }
          _dunSbIdx = e.shiftKey ? _dunSbIdx - 1 : _dunSbIdx + 1;
          if (_dunSbIdx < 0) _dunSbIdx = at.length - 1;
          if (_dunSbIdx >= at.length) _dunSbIdx = 0;
          const sp = at[_dunSbIdx];
          sayU(`${sp.name}${sp.available === false ? ', no slots' : ''}.`);
          return;
        }
        if (e.key === 'Enter' || e.code === 'NumpadEnter') {
          e.preventDefault();
          if (_dunSbLevel == null || _dunSbIdx < 0) { sayU('Tab to a spell first, then Return to cast.'); return; }
          const at = spells.filter(s => s.slvl === _dunSbLevel);
          const sp = at[_dunSbIdx];
          if (!sp) { sayU('No spell selected.'); return; }
          if (!myTurn) { sayU('Not your turn.'); return; }
          if (sp.available === false) { sayU(`${sp.name} is out of slots.`); return; }
          closeSb();
          // Skip the pre-announce when castSpell will PROMPT for a target (ally
          // pick, dispel pick, or a single-target enemy spell with 2+ foes) — the
          // picker speaks its own "on whom?" / "select a target" line.
          const willPrompt = sp.allyPick || sp.dispelPick
            || (sp.target === 'enemy' && sp.effect !== 'missile' && aliveE.length > 1);
          if (!willPrompt) sayU(`Casting ${sp.name}.`);
          castSpell(sp);
          return;
        }
        // Any other key falls through to the normal handlers below.
      }
      // ----- Ally-pick sub-mode (a targeted ally spell awaiting its target) ----
      //   A number picks that party member; Return casts on the smart auto-pick;
      //   Escape cancels (the slot is NOT spent — nothing was sent yet).
      if (_dunAllyPick) {
        if (e.key === 'Escape') { e.preventDefault(); _dunAllyPick = null; sayU('Cancelled.'); return; }
        if (e.key === 'Enter' || e.code === 'NumpadEnter') {
          e.preventDefault();
          const p = _dunAllyPick; _dunAllyPick = null;
          if (!myTurn) { sayU('Not your turn.'); return; }
          sayU(`Casting ${p.label} on the best target.`);
          dungeonAction('ability', { slot: p.slot });   // no allyUid → server smart-picks
          return;
        }
        const am = (e.key || '').match(/^[1-9]$/);
        if (am) {
          e.preventDefault();
          const p = _dunAllyPick;
          const pid = p.allies[parseInt(e.key, 10) - 1];
          if (!pid) { sayU(`No ally ${e.key}.`); return; }
          _dunAllyPick = null;
          if (!myTurn) { sayU('Not your turn.'); return; }
          const who = (d.party || []).find(x => x.playerId === pid);
          sayU(`Casting ${p.label} on ${who ? who.nickname : 'them'}.`);
          dungeonAction('ability', { slot: p.slot, allyUid: pid });
          return;
        }
        // any other key cancels the pending pick and falls through
        _dunAllyPick = null;
      }
      // ----- Dispel-pick sub-mode (Dispel Magic awaiting an ally OR foe) -------
      //   A number picks that target; Return = smart auto-pick; Escape cancels.
      if (_dunDispelPick) {
        if (e.key === 'Escape') { e.preventDefault(); _dunDispelPick = null; sayU('Cancelled.'); return; }
        if (e.key === 'Enter' || e.code === 'NumpadEnter') {
          e.preventDefault();
          const p = _dunDispelPick; _dunDispelPick = null;
          if (!myTurn) { sayU('Not your turn.'); return; }
          sayU(`Casting ${p.label} on the best target.`);
          dungeonAction('ability', { slot: p.slot });   // no target → server smart-picks / refuses
          return;
        }
        const dm = (e.key || '').match(/^[1-9]$/);
        if (dm) {
          e.preventDefault();
          const p = _dunDispelPick;
          const t = p.targets[parseInt(e.key, 10) - 1];
          if (!t) { sayU(`No target ${e.key}.`); return; }
          _dunDispelPick = null;
          if (!myTurn) { sayU('Not your turn.'); return; }
          sayU(`Casting ${p.label} on ${t.name}.`);
          dungeonAction('ability', t.kind === 'ally' ? { slot: p.slot, allyUid: t.id } : { slot: p.slot, targetUid: t.id });
          return;
        }
        _dunDispelPick = null;   // any other key cancels + falls through
      }
      // ----- Channel mode sub-mode (Channel awaiting offensive/defensive) -----
      //   1 = heal the party · 2 = sear the undead · Return = smart auto · Esc cancels.
      if (_dunModePick) {
        if (e.key === 'Escape') { e.preventDefault(); _dunModePick = null; sayU('Cancelled.'); return; }
        if (e.key === 'Enter' || e.code === 'NumpadEnter') {
          e.preventDefault();
          const p = _dunModePick; _dunModePick = null;
          if (!myTurn) { sayU('Not your turn.'); return; }
          sayU(`Channeling — the smart choice.`);
          dungeonAction('ability', { slot: p.slot });   // no mode → server auto-decides
          return;
        }
        if (e.key === '1' || e.key === '2') {
          e.preventDefault();
          const p = _dunModePick; _dunModePick = null;
          if (!myTurn) { sayU('Not your turn.'); return; }
          const mode = e.key === '1' ? 'defensive' : 'offensive';
          sayU(e.key === '1' ? 'Channeling to heal the party.' : 'Channeling to sear the undead.');
          dungeonAction('ability', { slot: p.slot, mode });
          return;
        }
        _dunModePick = null;   // any other key cancels + falls through
      }
      // ----- Session menu (opened by Esc) ------------------------------------
      // A self-contained sub-mode for the spectate / leave / cancel controls. Done
      // as a key-driven menu (not DOM focus) because the dungeon re-renders
      // constantly — which blew away button focus so Tab/Enter never worked — and
      // because Return would otherwise be hijacked by the open-door hotkey below.
      const SESSION_ITEMS = [
        { label: 'Spectate', fn: () => bailToSpectate() },
        { label: 'Bail out with your share', fn: () => { sayU('Bailing out with your gold.'); dungeonAction('bail'); } },
        { label: 'Leave dungeon', fn: () => returnFromDungeon() },
        { label: 'Cancel run', fn: () => cancelDungeon() },
      ];
      if (_dunSessionMode) {
        if (e.key === 'Tab') {
          e.preventDefault();
          _dunSessionIdx = (e.shiftKey ? _dunSessionIdx - 1 + SESSION_ITEMS.length : _dunSessionIdx + 1) % SESSION_ITEMS.length;
          sayU(SESSION_ITEMS[_dunSessionIdx].label + '.'); return;
        }
        // Numbers are deliberately NOT mapped here (Josh: a stray number after Esc
        // bailed/cancelled his run). The session menu is Tab-to-cycle, Return-to-
        // activate ONLY; everything else is swallowed below.
        if (e.key === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); const it = SESSION_ITEMS[_dunSessionIdx]; _dunSessionMode = false; sayU(it.label + '.'); it.fn(); return; }
        if (e.key === 'Escape') { e.preventDefault(); _dunSessionMode = false; sayU('Session menu closed.'); return; }
        // Swallow anything else so you can't accidentally attack while deciding.
        e.preventDefault(); return;
      }
      // E = toggle "inspect enemies" browse mode.
      if (k === 'e') {
        e.preventDefault();
        if (_blindHelp) { sayU('E: inspect enemies — Tab to cycle, Return to target, E to exit.'); return; }
        _dunEnemyMode = !_dunEnemyMode; _dunEnemyIdx = -1;
        if (_dunEnemyMode) sayU(`Enemy inspect: ${aliveE.length} ${aliveE.length === 1 ? 'enemy' : 'enemies'}. Tab to cycle, a number to jump, Return to target it, E to exit.`);
        else sayU('Exited enemy inspect.');
        return;
      }
      // In inspect mode: Tab / Shift+Tab cycle through enemies; Esc or E exits.
      if (_dunEnemyMode && e.key === 'Tab') {
        e.preventDefault();
        if (!aliveE.length) { sayU('No enemies.'); return; }
        _dunEnemyIdx = (e.shiftKey ? _dunEnemyIdx - 1 : _dunEnemyIdx + 1);
        if (_dunEnemyIdx < 0) _dunEnemyIdx = aliveE.length - 1;
        if (_dunEnemyIdx >= aliveE.length) _dunEnemyIdx = 0;
        sayU(enemyDesc(aliveE[_dunEnemyIdx], _dunEnemyIdx));
        return;
      }
      if (_dunEnemyMode && e.key === 'Escape') { e.preventDefault(); _dunEnemyMode = false; sayU('Exited enemy inspect.'); return; }
      // In help mode R and P announce themselves even when no treasure is on the
      // table (the real handler below only fires during a loot roll).
      if (_blindHelp && (k === 'r' || k === 'p')) {
        e.preventDefault();
        sayU(k === 'r' ? 'R: roll a d20 for dropped treasure.' : 'P: pass on dropped treasure.');
        return;
      }
      // Treasure: R = roll a d20, P = pass — when it's mine to decide (spoken).
      if ((k === 'r' || k === 'p') && d.lootRoll && (d.lootRoll.eligible || []).includes(meId) && (d.lootRoll.decided || {})[meId] === undefined) {
        e.preventDefault();
        if (k === 'r') { sayU('Rolling for it.'); dungeonAction('lootroll', { roll: true }); }
        else { sayU('Passing.'); dungeonAction('lootroll', { roll: false }); }
        return;
      }
      // Return while INSPECTING enemies (E mode): lock the current enemy as your
      // target — attack it now if it's your turn, otherwise queue it to auto-attack
      // the moment your turn begins.
      if ((e.key === 'Enter' || e.code === 'NumpadEnter') && _dunEnemyMode) {
        e.preventDefault();
        if (!aliveE.length) { sayU('No enemies.'); return; }
        const en = aliveE[_dunEnemyIdx >= 0 ? _dunEnemyIdx : 0];
        _dunEnemyMode = false;
        if (_blindHelp) { sayU(`Return: target ${en.name}.`); return; }
        // An action is already ARMED and waiting for a target (e.g. you pressed
        // Cleave, then browsed here to pick the victim): fire THAT action on this
        // enemy — and clear it, so it can't go stale and swallow next turn's keys.
        if (_dunTarget && myTurn) {
          const pend = _dunTarget; _dunTarget = null;
          sayU(`${pend.label} ${en.name}.`);
          if (pend.kind === 'attack') dungeonAction('attack', { targetUid: en.uid });
          else dungeonAction('ability', { slot: pend.slot, targetUid: en.uid, targetUids: [en.uid] });
          return;
        }
        _dunTarget = null;   // never leave a stale pending action behind this path
        if (myTurn) { _dunQueuedAttack = null; sayU(`Attacking ${en.name}.`); dungeonAction('attack', { targetUid: en.uid }); }
        else {
          // Off-turn lock → the SERVER queues the attack and fires it the moment
          // the turn comes (re-locking replaces it). Local mirror only feeds the
          // E-menu "locked" readout.
          _dunQueuedAttack = en.uid; emitAim(en.uid);
          dungeonAction('attack', { targetUid: en.uid });
          sayU(`${en.name} locked in — your attack fires the moment your turn comes.`);
        }
        return;
      }
      // C = Cantrip: cycle your at-will ray's element (cold → acid → electricity →
      // …) — a free action, any time. Casters only; announces the new element.
      if (k === 'c') {
        e.preventDefault();
        if (_blindHelp) { window.BlindMode.speak('C: switch your cantrip element.', 'urgent'); return; }
        const ct = meM.cantrip;
        if (!ct || !(ct.choices || []).length) { window.BlindMode.speak('You have no cantrip to switch.', 'urgent'); return; }
        const idx = ct.choices.findIndex(x => x.key === ct.current);
        const next = ct.choices[(idx + 1) % ct.choices.length];
        window.BlindMode.speak(`Cantrip: ${next.name}, ${next.dtype}.`, 'urgent');
        dungeonAction('cantrip', { key: next.key });
        return;
      }
      // M = Money: the gold this run has piled up so far (the run pool), plus depth.
      if (k === 'm') {
        e.preventDefault();
        if (_blindHelp) { window.BlindMode.speak('M: gold earned this run.', 'urgent'); return; }
        const pool = d.runGold | 0;
        window.BlindMode.speak(`${pool} gold in the run pool, depth ${d.depth | 0}.`, 'urgent');
        return;
      }
      // L = Life: your current HP and any status (e.g. "5 of 35 HP, paralyzed").
      if (k === 'l') {
        e.preventDefault();
        if (_blindHelp) { window.BlindMode.speak('L: your life and status.', 'urgent'); return; }
        if (!meM.playerId) { window.BlindMode.speak('You are not in the party.', 'urgent'); return; }
        const hp = Math.max(0, meM.hp | 0), max = meM.maxHp | 0;
        const buffs = (meM.buffs || []).map(b => String(b.label || '').toLowerCase()).filter(Boolean);
        const conds = (meM.conditions || []).map(c => String(c.label || '').toLowerCase()).filter(Boolean);
        // Lead with LEVEL + class so a blind player can confirm what level they are at
        // any time (Josh: "I cannot confirm my level by any means in the dungeon").
        const lvl = meM.level ? `Level ${meM.level}${meM.cls ? ' ' + meM.cls : ''}, ` : '';
        let s = `${lvl}${hp} of ${max} HP`;
        if (meM.dead) s += ', dead';
        else if (meM.downed || hp <= 0) s += ', downed';
        const statuses = [...buffs, ...conds];   // buffs (boons) then conditions (debuffs)
        if (statuses.length) s += ', ' + statuses.join(', ');
        window.BlindMode.speak(s + '.', 'urgent');
        return;
      }
      // H = party Health: a quick HP run-down of every delver (dungeon only — at the
      // poker table H re-reads your hand; the two key sets are separate by screen).
      if (k === 'h') {
        e.preventDefault();
        if (_blindHelp) { window.BlindMode.speak('H: party health summary.', 'urgent'); return; }
        const party = (d.party || []).filter(p => !p.left);
        if (!party.length) { window.BlindMode.speak('No party.', 'urgent'); return; }
        const parts = party.map(p => {
          const hp = Math.max(0, p.hp | 0), max = p.maxHp | 0;
          let s = `${p.nickname} ${hp} of ${max}`;   // no "you," self-label — Josh knows which character he plays
          if (p.dead) s += ', dead';
          else if (p.downed || hp <= 0) s += ', down';
          return s;
        });
        window.BlindMode.speak('Party: ' + parts.join('; ') + '.', 'urgent');
        return;
      }
      if (/^[1-9]$/.test(k)) {
        e.preventDefault();
        const n = parseInt(k, 10);
        const alive = (d.enemies || []).filter(x => x.alive).sort(byCr);   // highest-CR first
        // (0) In enemy-inspect mode, a number jumps to + describes that enemy.
        if (_dunEnemyMode) {
          const en = alive[n - 1];
          if (!en) { sayU(`No enemy ${n}.`); return; }
          _dunEnemyIdx = n - 1; sayU(enemyDesc(en, n - 1)); return;
        }
        // (a) In "select a target" mode, the number picks the enemy and fires the
        //     pending action on it.
        if (_dunTarget) {
          // The turn may have ended while a target was pending — never fire off-turn.
          if (!myTurn) { _dunTarget = null; window.BlindMode.speak('Not your turn.', 'urgent'); return; }
          const tgt = alive[n - 1];
          if (!tgt) { window.BlindMode.speak(`No enemy ${n}.`, 'urgent'); return; }
          const pend = _dunTarget; _dunTarget = null;
          window.BlindMode.speak(`${pend.label} ${tgt.name}.`, 'urgent');
          if (pend.kind === 'attack') dungeonAction('attack', { targetUid: tgt.uid });
          else dungeonAction('ability', { slot: pend.slot, targetUid: tgt.uid, targetUids: [tgt.uid] });
          return;
        }
        // (b) Otherwise the number chooses an action from the blind action list:
        //     1 = Attack, then each class FEATURE, then "Spellbook" (casters).
        const act = blindActions[n - 1];
        if (!act) { window.BlindMode.speak(`No action ${n}.`, 'urgent'); return; }
        if (_blindHelp) { window.BlindMode.speak(`${n}: ${act.label}.`, 'urgent'); return; }
        // Spellbook → open the sub-mode (numbers pick a spell LEVEL, Tab cycles
        // spells, Return casts). Browsable off-turn; the cast itself checks turn.
        if (act.kind === 'spellbook') {
          _dunSbMode = true; _dunSbLevel = null; _dunSbIdx = -1; _spellbookOpen = true;
          if (document.body.dataset.screen === 'dungeon') renderDungeon();
          sayU(`Spellbook. Levels: ${spellLevels.map(ord).join(', ')}. Pick a level, Tab through spells, Return to cast, Escape to close.`);
          return;
        }
        if (!myTurn) { window.BlindMode.speak('Not your turn.', 'ambient'); return; }   // AMBIENT — never cut off the end-of-room report (Josh)
        const ab = act.ab || null;
        const label = act.label;
        // Ally-targeted FEATURE (a druid's Cure, Barkskin, Bull's Strength…) →
        // prompt for the ally (numbers pick, Return = smart auto-pick).
        if (ab && ab.allyPick) {
          const party = (d.party || []).filter(p => !p.left && !p.dead);
          _dunAllyPick = { slot: act.slot, label, allies: party.map(p => p.playerId) };
          const list = party.map((p, i) => `${i + 1} ${p.nickname}${p.playerId === meId ? ', you' : ''}`).join(', ');
          sayU(`${label} on whom? ${list}. Press a number, or Return for the best target.`);
          return;
        }
        // Dispel Magic feature (e.g. druid) — pick an afflicted ally or enchanted foe.
        if (ab && ab.dispelPick) {
          const CC = ['held', 'paralyzed', 'slowed', 'grappled', 'blinded', 'sickened', 'stunned'];
          const allies = (d.party || []).filter(p => !p.left && !p.dead && (p.conditions || []).some(c => CC.includes(c.key)));
          const foes = alive.filter(e => (e.buffs || []).length);
          const targets = allies.map(p => ({ kind: 'ally', id: p.playerId, name: p.nickname }))
                       .concat(foes.map(e => ({ kind: 'foe', id: e.uid, name: e.name })));
          if (!targets.length) { sayU(`Casting ${label}.`); dungeonAction('ability', { slot: act.slot }); return; }
          _dunDispelPick = { slot: act.slot, label, targets };
          const list = targets.map((t, i) => `${i + 1} ${t.name}${t.kind === 'ally' ? ' (cleanse)' : ' (strip)'}`).join(', ');
          sayU(`${label} on whom? ${list}. Press a number, or Return for the best target.`);
          return;
        }
        // Channel feature — offensive (sear undead) vs defensive (heal party).
        if (ab && ab.modePick) {
          _dunModePick = { slot: act.slot, label };
          sayU(`${label}: press 1 to heal the party, 2 to sear the undead, or Return for the smart choice.`);
          return;
        }
        // Single-enemy-target actions (basic attack, or an ability that targets one
        // enemy) with MORE THAN ONE foe alive → ask which enemy; the next number
        // selects it. One foe (or an AoE/self/ally action) just fires.
        const singleEnemyTarget = act.kind === 'attack' || (ab && ab.target === 'enemy');
        if (singleEnemyTarget && alive.length > 1) {
          _dunTarget = { kind: act.kind === 'attack' ? 'attack' : 'ability', slot: act.slot, label };
          const list = alive.slice(0, 9).map((x, i) => `${i + 1}, ${x.name}${x.flying ? ', flying' : ''}${x.cr ? `, CR ${x.cr}` : ''}, ${Math.max(0, x.hp | 0)} HP`).join('; ');
          window.BlindMode.speak(`${label} — select a target, deadliest first: ${list}.`, 'urgent');
          return;
        }
        const targetUid = alive[0]?.uid;
        window.BlindMode.speak(`${label}.`, 'urgent');
        if (act.kind === 'attack') dungeonAction('attack', { targetUid });
        else dungeonAction('ability', { slot: act.slot, targetUid, targetUids: alive.slice(0, 6).map(x => x.uid) });
        return;
      }
      // 0 = open the next door. Number-row zero AND numpad zero both land here
      // (Numpad0's e.key is '0'). Return and O are deliberately NOT door keys in
      // blind mode (Josh's report): Return's only job is confirming inside the
      // spellbook / session menu / enemy inspect sub-modes.
      if (k === '0') {
        e.preventDefault();
        if (_blindHelp) { window.BlindMode.speak('0: open the next door. Number row or numpad.', 'urgent'); return; }
        if (d.status === 'combat') { window.BlindMode.speak('Cannot open a door during combat.', 'urgent'); return; }
        window.BlindMode.speak('Opening the door.', 'urgent'); dungeonAction('door'); return;
      }
      // . (period) is UNMAPPED (Josh: kept cancelling his run by fat-fingering it
      // while moving fast). Cancel-run now lives ONLY in the Escape session menu.
      if (e.key === '.') {
        e.preventDefault();
        if (_blindHelp) window.BlindMode.speak('Period: unmapped. Cancel the run from the Escape menu.', 'urgent');
        return;
      }
      // Esc → session controls. If a dropdown/overlay is open, let the global Esc
      // handler close that first; otherwise jump focus to the Spectate / Leave /
      // Cancel group and announce it.
      if (e.key === 'Escape') {
        if (_dunTarget) { e.preventDefault(); _dunTarget = null; window.BlindMode.speak('Target selection cancelled.', 'urgent'); return; }
        const overlayOpen = _spellbookOpen || _recruitOpen || _bankDollOpen
          || !!document.querySelector('.modal:not([hidden])')
          || !!$('#audioMenu')?.classList.contains('is-open');
        if (overlayOpen) return;
        e.preventDefault();
        if (_blindHelp) { window.BlindMode.speak('Escape: open the session menu — spectate, bail out with your share, leave, or cancel.', 'urgent'); return; }
        _dunSessionMode = true; _dunSessionIdx = 0;
        window.BlindMode.speak('Session menu. Tab through spectate, bail out with your share, leave dungeon, and cancel run; Return to choose; Escape to exit. Spectate.', 'urgent');
        return;
      }
      // B = read out the whole party's active buffs and conditions (Josh: L
      // already reads HIS own HP + buffs; B covers the rest of the team). Bail
      // moved to the Escape session menu so a stray B can't end your run.
      if (k === 'b') {
        e.preventDefault();
        if (_blindHelp) { sayU('B: read every party member’s active buffs. Debuffs are on the D key now. Bail lives in the Escape menu.'); return; }
        const liveP = (d.party || []).filter(p => !p.left && !p.dead);
        if (!liveP.length) { sayU('No party members.'); return; }
        // Streamlined (Josh): report buffs that matter to the PARTY — haste, communal/
        // party buffs, and notable conditions — but skip each character's personal
        // attack toggles (Power Attack / Deadly Aim / Rapid Shot), which are their
        // own business, not party info.
        const PERSONAL = new Set(['powerattack', 'deadlyaim', 'rapidshot', 'fightdefensively']);
        const lines = liveP.map(p => {
          const items = (p.buffs || []).filter(b => !PERSONAL.has(b.key)).map(b => b.label);   // BUFFS only — debuffs moved to the D key (Josh), keeps B short
          return `${p.nickname}: ${items.length ? items.join(', ') : 'no buffs'}`;   // no "you," self-label (Josh knows which character he plays)
        });
        sayU('Party buffs. ' + lines.join('. ') + '.');
        return;
      }
      // D = DEBUFFS ONLY, on you and the party (Josh): a fast "who's held / what bad
      // thing is up" without wading through everyone's buffs (the B report). Lists only
      // members who actually HAVE a debuff (conditions), so it stays short mid-fight.
      if (k === 'd') {
        e.preventDefault();
        if (_blindHelp) { sayU('D: debuffs only — bad conditions on you and the party, like held or sickened.'); return; }
        const liveP = (d.party || []).filter(p => !p.left && !p.dead);
        if (!liveP.length) { sayU('No party members.'); return; }
        const lines = liveP.map(p => {
          const debs = (p.conditions || []).map(c => c.label).filter(Boolean);
          return debs.length ? `${p.nickname}: ${debs.join(', ')}` : null;
        }).filter(Boolean);
        sayU(lines.length ? 'Debuffs. ' + lines.join('. ') + '.' : 'No debuffs on the party.');
        return;
      }
      // Blind mode NEVER falls through to the sighted letter scheme below — that
      // leak is how O and Return opened doors, B bailed from inside help mode, and
      // Q/W fired abilities (all Josh's 6/11 report). Unassigned letters answer in
      // help mode ("S: not assigned") and otherwise point at the real keys.
      if (/^[a-z]$/.test(k)) {
        e.preventDefault();
        if (_blindHelp) sayU(`${k.toUpperCase()}: not assigned. Actions are on the number keys. 0 opens the door, L reads your buffs, B reads the party’s buffs, Escape opens the session menu (bail, leave, cancel).`);
        else if (['q', 'w', 'a', 'o'].includes(k)) sayU('Not assigned in blind mode. Actions are on the number keys — press question mark for help.');
        return;
      }
      // Return outside the sub-modes has no job (it confirms in the spellbook,
      // session menu, and enemy inspect). Swallow it when nothing has focus so it
      // can't leak into the sighted door binding; leave it alone on a focused
      // control so buttons still click.
      if ((e.key === 'Enter' || e.code === 'NumpadEnter') && (!document.activeElement || document.activeElement === document.body)) {
        e.preventDefault();
        if (_blindHelp) sayU('Return: confirms inside the spellbook, session menu, and enemy inspect. 0 opens doors.');
        return;
      }
      return;   // anything else: ignored in blind mode (Tab keeps its browser default)
    }
    // Loot roll: R = roll d20, P = pass (only when it's mine to decide).
    if (d.lootRoll) {
      const mine = (d.lootRoll.decided || {})[state.me?.player_id];
      const elig = (d.lootRoll.eligible || []).includes(state.me?.player_id);
      if (elig && mine === undefined) {
        if (k === 'r') { e.preventDefault(); dungeonAction('lootroll', { roll: true }); return; }
        if (k === 'p') { e.preventDefault(); dungeonAction('lootroll', { roll: false }); return; }
      }
    }
    if (/^[1-9]$/.test(k)) {
      const alive = (d.enemies || []).filter(x => x.alive);
      const uid = alive[parseInt(k, 10) - 1]?.uid;
      if (uid) {
        const i = _dungeonSel.indexOf(uid);
        if (i >= 0) _dungeonSel.splice(i, 1);
        else { _dungeonSel.push(uid); if (_dungeonSel.length > 2) _dungeonSel.shift(); }
        renderDungeon();
      }
      e.preventDefault(); return;
    }
    // A = at-will attack, Q/W = the two class abilities, O/Enter = door, B = bail.
    let act = null, slot = 0;
    if (k === 'a') act = 'attack';
    else if (k === 'q') { act = 'ability'; slot = 0; }
    else if (k === 'w') { act = 'ability'; slot = 1; }
    else if (k === 'o' || k === 'enter') act = 'door';
    else if (k === 'b') act = 'bail';
    if (!act) return;
    e.preventDefault();
    if (act === 'attack') dungeonAction('attack', { targetUid: _dungeonSel[0] });
    else if (act === 'ability') dungeonAction('ability', { slot, targetUid: _dungeonSel[0], targetUids: _dungeonSel.slice(0, 6) });
    else dungeonAction(act);
    if (act === 'attack' || act === 'ability') _dungeonSel = [];
  });

  // Incremental chat events (in addition to the snapshot in table:state).
  socket.on('table:chat', (entry) => {
    if (entry && typeof entry === 'object') {
      appendChatEntry(entry);
      window.BlindMode?.onChat?.(entry);
      // Banter audio attached server-side. Two flavours:
      //   - entry.audioUrl  static MP3 from public/audio/ (Crisp's
      //                     chirps, Elfrip's burps — no 11labs call)
      //   - entry.audio     base64 MP3 from 11labs synthesis
      // Both gated by the same banter-voice toggle.
      if (_bannerVoiceEnabled && entry.kind === 'banter') {
        if (entry.audioUrl) {
          // In the dungeon, table banter (incl. Crisp/Elfrip chirps) is muffled —
          // SAME muffle as the 11labs voices (shared VOICE_MUFFLE_* constants).
          if (_inDungeon) { playUrl(entry.audioUrl, _voiceVolume * VOICE_MUFFLE_VOL, true, VOICE_MUFFLE_HZ); }
          else { enqueueVoiceUrl(entry.audioUrl); }   // through the SpeechBus — no overlap with narration
        } else if (entry.audio) {
          enqueueVoice(entry.audio, entry.audioMime || 'audio/mpeg', _inDungeon);   // muffle when down in the dungeon
        }
      }
      // Fight-gag SFX play for EVERYONE at the table, independent of the
      // banter-voice toggle — it's a shared event, like a card sound. Gated
      // by the per-category combat toggle (sword / lightning / fart).
      if (entry.kind === 'fight' && entry.audioUrl && combatSoundEnabled(entry.audioUrl)) {
        try { const fx = new Audio(entry.audioUrl); fx.volume = _combatVolume; fx.play().catch(()=>{}); } catch (_) {}
      }
    }
  });

  // ===== Roster picker =====
  /** Compute total worth = chips + market value of every gear slot. */
  function rosterWealth(p) {
    let total = Number(p.chips || 0);
    try {
      const gear = JSON.parse(p.gear || '{}') || {};
      for (const slot of GEAR_SLOTS) {
        const tier = gear[slot] || 0;
        if (tier) total += gearPrice(slot, tier);
      }
    } catch (_) {}
    return total;
  }
  /** Count how many of the 6 gear slots a player owns. */
  function rosterGearCount(p) {
    try {
      const gear = JSON.parse(p.gear || '{}') || {};
      return GEAR_SLOTS.filter(s => gear[s]).length;
    } catch { return 0; }
  }

  function rosterCardHtml(p) {
    const wealth = rosterWealth(p);
    const gearCount = rosterGearCount(p);
    const badge = p.is_bot
      ? `<span class="roster-pick__badge roster-pick__badge--bot" title="AI-playable character — superseded while a human controls the seat">🤖 AI</span>`
      : `<span class="roster-pick__badge roster-pick__badge--human" title="Reserved human seat — AI never plays this identity">👤 Human</span>`;
    // Show chips on first line; total worth + gear count on second line
    // when there's gear or accumulated wealth beyond the buy-in.
    const chipsLine = `<div class="roster-pick__chips">💰 ${formatChips(p.chips)} gp</div>`;
    const wealthLine = (wealth > Number(p.chips || 0))
      ? `<div class="roster-pick__worth" title="Total wealth (chips + market value of gear)">⚔️ ${formatChips(wealth)} gp${gearCount ? ' · ' + gearCount + '/6' : ''}</div>`
      : '';
    return `
      ${badge}
      <div class="roster-pick__avatar">${renderAvatar(p.avatar_id)}</div>
      <div class="roster-pick__nick">${escapeText(p.nickname)}</div>
      ${chipsLine}
      ${wealthLine}`;
  }

  function renderRoster() {
    const host = $('#rosterGrid');
    host.innerHTML = '';
    // "Create New Player" — ALWAYS the first option (Tobias). Prompts for a name,
    // creates a fresh human identity server-side, then drops into the avatar/confirm
    // screen like any other pick.
    {
      const wrap = document.createElement('div');
      wrap.className = 'roster-section-grid';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'roster-pick roster-pick--create';
      btn.innerHTML = `<span class="roster-pick__badge roster-pick__badge--human" title="Make a brand-new human seat">✨ New</span>
        <div class="roster-pick__avatar" style="font-size:2em;display:flex;align-items:center;justify-content:center">➕</div>
        <div class="roster-pick__nick">Create New Player</div>
        <div class="roster-pick__chips">Start a fresh seat</div>`;
      btn.addEventListener('click', () => {
        const name = (window.prompt('New player name:') || '').trim();
        if (!name) return;
        socket.emit('lobby:createPlayer', { name }, (resp) => {
          if (!resp?.ok) { toast(resp?.error || 'Could not create player', true); return; }
          state.roster = [...(state.roster || []).filter(r => r.player_id !== resp.player.player_id), resp.player];
          onPickName(resp.player.player_id);
        });
      });
      wrap.appendChild(btn);
      host.appendChild(wrap);
    }
    const all = state.roster || [];
    const humans = all.filter(p => !p.is_bot)
      .sort((a, b) => (a.nickname || '').localeCompare(b.nickname || '', undefined, { sensitivity: 'base' }));
    // AI characters sorted by wealth (richest first) — makes the list a
    // mini secondary leaderboard right in the picker.
    const bots = all.filter(p => p.is_bot)
      .map(p => ({ p, w: rosterWealth(p) }))
      .sort((a, b) => b.w - a.w)
      .map(x => x.p);

    function makeCard(p) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'roster-pick ' + (p.is_bot ? 'roster-pick--bot' : 'roster-pick--reserved');
      card.dataset.playerId = p.player_id;
      card.innerHTML = rosterCardHtml(p);
      card.addEventListener('click', () => onPickName(p.player_id));
      return card;
    }

    function section(title, subtitle, players, kind) {
      const head = document.createElement('div');
      head.className = 'roster-section-head roster-section-head--' + kind;
      head.innerHTML = `<h2>${title}</h2><p>${subtitle}</p>`;
      host.appendChild(head);
      const grid = document.createElement('div');
      grid.className = 'roster-section-grid';
      for (const p of players) grid.appendChild(makeCard(p));
      host.appendChild(grid);
    }

    if (humans.length) {
      section('👤 Reserved Humans',
        `${humans.length} seats saved for real friends — AI never plays these.`,
        humans, 'human');
    }
    if (bots.length) {
      section('🤖 AI Characters',
        `${bots.length} personalities you can sit in for. Pick one and you take over their fortune, gear, and seat. Ranked by current worth.`,
        bots, 'bot');
    }
  }

  function onPickName(playerId) {
    const p = state.roster.find(r => r.player_id === playerId);
    if (!p) return;
    state.pendingPlayerId = playerId;
    state.pendingAvatar = p.avatar_id;
    setScreen('confirm');
    renderConfirm();
  }

  // ===== Confirm — token gallery picker =====
  async function ensureTokensLoaded() {
    if (state.tokens) return state.tokens;
    try {
      const r = await fetch('/tokens/manifest.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error('manifest ' + r.status);
      const data = await r.json();
      if (!Array.isArray(data)) throw new Error('bad manifest shape');
      // Sort order: PCs first (most-pickable), then iconic villains,
      // then NPCs (allied / non-antagonist named characters), then
      // generic recent tokens. Inside each tier, alphabetical.
      const rank = t => t.pc ? 0 : (t.villain ? 1 : (t.npc ? 2 : 3));
      data.sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r) return r;
        return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
      });
      state.tokens = data;
    } catch (e) {
      console.warn('[tokens] could not load gallery:', e);
      state.tokens = [];   // sentinel so we don't refetch on every render
    }
    return state.tokens;
  }

  /** Render the visible subset of the gallery, optionally filtered by `query`. */
  function renderTokenGrid(query = '') {
    const grid = $('#confirmAvatarGrid');
    if (!grid) return;
    const tokens = state.tokens || [];
    const q = query.trim().toLowerCase();
    const matched = q
      ? tokens.filter(t =>
          t.name.toLowerCase().includes(q)
          || t.id.toLowerCase().includes(q)
          || (t.class    || '').toLowerCase().includes(q)
          || (t.race     || '').toLowerCase().includes(q)
          || (t.player   || '').toLowerCase().includes(q)
          || (t.campaign || '').toLowerCase().includes(q))
      : tokens;
    const counter = $('#tokenCount');
    if (counter) counter.textContent =
      q ? `${matched.length} of ${tokens.length} match "${query}"` : `${tokens.length} tokens`;
    grid.innerHTML = '';

    // ALWAYS render the simple preset avatars first. They need no gallery
    // fetch, so the picker is never empty (even if the token manifest fails
    // to load), and they give a short, easy list for quick or blind picks.
    const presetClick = (id) => () => {
      state.pendingAvatar = id;
      $('#confirmAvatarBig').innerHTML = renderAvatar(id);
      $$('#confirmAvatarGrid .avatar-pick').forEach(el =>
        el.setAttribute('aria-checked', el.dataset.avatar === id ? 'true' : 'false'));
    };
    const presetIds = q ? ALL_AVATARS.filter(a => a.includes(q)) : ALL_AVATARS;
    for (const id of presetIds) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'avatar-pick avatar-pick--preset';
      b.setAttribute('role', 'radio');
      b.dataset.avatar = id;
      const label = id.charAt(0).toUpperCase() + id.slice(1);
      b.title = label;
      b.setAttribute('aria-checked', id === state.pendingAvatar ? 'true' : 'false');
      b.innerHTML = renderAvatar(id) + `<span class="avatar-pick__label">${label}</span>`;
      b.addEventListener('click', presetClick(id));
      grid.appendChild(b);
    }
    // Pin the player's currently-selected token (= last-used, since we
    // initialise pendingAvatar from their persisted avatar_id when the
    // confirm screen opens) to the very top of the visible list, no
    // matter where it falls alphabetically or in the tier ranking.
    // Makes re-selecting the same avatar a one-tap operation.
    let ordered = matched;
    if (state.pendingAvatar) {
      const pinIdx = matched.findIndex(t => t.art === state.pendingAvatar);
      if (pinIdx > 0) {
        ordered = [matched[pinIdx], ...matched.slice(0, pinIdx), ...matched.slice(pinIdx + 1)];
      }
    }
    // Cap rendered items at 200 to keep the DOM snappy; if filter narrows it,
    // they all show.
    const slice = ordered.slice(0, 200);
    for (const tok of slice) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'avatar-pick avatar-pick--token';
      btn.role = 'radio';
      btn.dataset.avatar = tok.art;
      btn.title = tok.name;
      btn.setAttribute('aria-checked', tok.art === state.pendingAvatar ? 'true' : 'false');
      const CAMPAIGN_NAMES = {
        CC: 'Carrion Crown', TG: 'Tyrant\'s Grasp', IG: 'Iron Gods',
        HV: 'Hell\'s Vengeance', HR: 'Hell\'s Rebels', SS: 'Skull & Shackles',
        JG: 'Justice Gorls',
      };
      const subBits = [tok.race, tok.class].filter(Boolean);
      const subLine = (tok.pc || tok.villain) && subBits.length
        ? `<span class="avatar-pick__sub">${escapeText(subBits.join(' · '))}</span>`
        : '';
      const campaignName = tok.campaign ? (CAMPAIGN_NAMES[tok.campaign] || tok.campaign) : '';
      let pcBadge = '';
      if (tok.villain) {
        pcBadge = `<span class="avatar-pick__pcbadge avatar-pick__pcbadge--villain" title="${escapeAttr([campaignName, 'Villain'].filter(Boolean).join(' · '))}">${escapeText(tok.campaign || 'V')}</span>`;
      } else if (tok.npc) {
        pcBadge = `<span class="avatar-pick__pcbadge avatar-pick__pcbadge--npc" title="${escapeAttr([campaignName, 'Named NPC'].filter(Boolean).join(' · '))}">${escapeText(tok.campaign || 'NPC')}</span>`;
      } else if (tok.pc) {
        pcBadge = `<span class="avatar-pick__pcbadge" title="${escapeAttr([campaignName, tok.player ? 'Player: ' + tok.player : ''].filter(Boolean).join(' · '))}">${escapeText(tok.campaign || 'PC')}</span>`;
      }
      btn.innerHTML = `<img class="avatar-img" src="${tok.art}" alt="${escapeAttr(tok.name)}" loading="lazy" />`
                    + pcBadge
                    + `<span class="avatar-pick__label">${escapeText(tok.name)}</span>`
                    + subLine;
      btn.addEventListener('click', () => {
        state.pendingAvatar = tok.art;
        $('#confirmAvatarBig').innerHTML = `<img class="avatar-img" src="${tok.art}" alt="${tok.name}" />`;
        $$('#confirmAvatarGrid .avatar-pick').forEach(el => {
          el.setAttribute('aria-checked', el.dataset.avatar === tok.art ? 'true' : 'false');
        });
      });
      grid.appendChild(btn);
    }
    if (matched.length > slice.length) {
      const more = document.createElement('div');
      more.className = 'avatar-pick__more';
      more.textContent = `(+${matched.length - slice.length} more — narrow your search)`;
      grid.appendChild(more);
    }
  }

  async function renderConfirm() {
    const p = state.roster.find(r => r.player_id === state.pendingPlayerId);
    if (!p) { setScreen('roster'); return; }
    $('#confirmNick').textContent = p.nickname;
    $('#confirmAvatarBig').innerHTML = renderAvatar(state.pendingAvatar);
    // Wire the search box once.
    const search = $('#confirmAvatarSearch');
    if (search && !search._wired) {
      search._wired = true;
      search.addEventListener('input', (e) => renderTokenGrid(e.target.value));
    }
    if (search) search.value = '';
    // Load gallery + render.
    const grid = $('#confirmAvatarGrid');
    grid.innerHTML = '<div class="avatar-pick__more">Loading gallery…</div>';
    await ensureTokensLoaded();
    renderTokenGrid('');
  }
  $('#confirmBackBtn').addEventListener('click', () => {
    state.pendingPlayerId = null;
    setScreen('roster');
    renderRoster();
  });
  $('#confirmGoBtn').addEventListener('click', () => {
    const playerId = state.pendingPlayerId;
    const avatarId = state.pendingAvatar;
    if (!playerId) return;
    socket.emit('lobby:choosePlayer', { playerId }, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'Could not pick player', true); return; }
      state.me = resp.player;
      try { sessionStorage.setItem(PLAYER_KEY, playerId); } catch (_) {}
      const enter = () => enterTable();
      if (avatarId && avatarId !== state.me.avatar_id) {
        socket.emit('lobby:setAvatar', { avatarId }, (r2) => {
          if (r2?.ok && r2.player) state.me = r2.player;
          enter();
        });
      } else enter();
    });
  });
  // Keyboard shortcut: ENTER on the confirm screen takes the seat right away
  // with the current avatar — no need to scroll the gallery. Great for quick
  // picks and blind users (the avatar search is type-ahead, so Enter there
  // has no other purpose).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (document.body.dataset.screen !== 'confirm') return;
    e.preventDefault();
    $('#confirmGoBtn')?.click();
  });

  // ===== Enter table =====
  function enterTable() {
    setScreen('table');
    paintMe();
    socket.emit('table:join', { tableId: 'main' }, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'Could not join table', true); return; }
      state.table = resp.state;
      renderTable();
      // Reloaded mid-run? The server says our hero is STILL standing in this
      // table's live dungeon (reconnect grace) — take the player straight back
      // into the run instead of stranding them at the table.
      if (resp.inDungeon) {
        toast('You are still in the dungeon — rejoining your run…');
        window.BlindMode?.speak?.('Reconnected. You are still in the dungeon — rejoining your run.', 'urgent');
        enterDungeon();
      }
    });
  }

  function paintMe() {
    const p = state.me; if (!p) return;
    // Pull this player's stored audio prefs on every paint — handles
    // initial login, switch-player, and refresh-with-restored-session.
    // No-ops cleanly when the keys aren't present yet (defaults kick in).
    loadAudioSettings();
    $('#meNick').textContent = p.nickname;
    // Sync the pronoun dropdown to the player's stored value. Defaults
    // to 'they' if the column is missing (legacy rows / old backend).
    const gsel = $('#meGender');
    if (gsel) gsel.value = (p.gender === 'he' || p.gender === 'she') ? p.gender : 'they';
    // Sync the PF1e class + weapon dropdowns (populated from lobby:pf1meta).
    syncClassWeapon(p);
    $('#meChips').textContent = '💰 ' + formatChips(p.chips) + ' gp';
    $('#meAvatar').innerHTML = renderAvatar(p.avatar_id);
    // Chat input becomes available once a character is chosen.
    const chatInput = $('#chatInput');
    const chatSend  = $('#chatSendBtn');
    if (chatInput) { chatInput.disabled = false; chatInput.placeholder = `Say something as ${p.nickname}… (Enter to send)`; }
    if (chatSend)  chatSend.disabled = false;
    // Sit out / Rejoin button label reflects current seat state.
    const mySeat = state.table?.seats?.find(s => s.playerId === p.player_id);
    const sitBtn = $('#sitOutBtn');
    if (sitBtn) {
      if (mySeat?.sittingOut) {
        sitBtn.textContent = 'Rejoin';
        sitBtn.title = 'Come back into the next deal.';
        sitBtn.classList.add('btn--sit-out-active');
      } else {
        sitBtn.textContent = 'Sit out';
        sitBtn.title = 'Keep your seat but skip upcoming deals. Click Rejoin to come back. Cannot undo bets in a hand already in progress.';
        sitBtn.classList.remove('btn--sit-out-active');
      }
    }
    // ---- Abadar-bank hover popover off the chips badge ----
    // Shows the player's outstanding debt and pay-down buttons. Hidden
    // by default; revealed by :hover on desktop, by tap-toggling
    // .is-open on touch. Only this client sees their own debt amount —
    // others get a red dot in the leaderboard but never the number.
    const pop = $('#mePursePop');
    if (pop) {
      const debt = Number(p.rebuy_debt || 0);
      const chips = Number(p.chips || 0);
      // Re-buy now lives in the money dropdown (moved out of the ≡ menu): it's
      // a money action, so it belongs with the bank. It's a LOAN added to debt.
      const rebuyRow = `<div class="purse__actions"><button type="button" class="purse__btn purse__btn--rebuy" data-rebuy title="Borrow a fresh ${formatChips(state.defaultStack)} gp stack from the Bank of Abadar — a loan added to your debt, paid down with winnings">🏛️ Loan from Abadar · ${formatChips(state.defaultStack)} gp</button></div>`;
      // 🏋️ "Hit the Dungeon" lives tucked inside the money dropdown (a play on
      // "hit the gym"). Clicking it leaves your seat and descends.
      const dungeonRow = `<div class="purse__actions"><button type="button" class="purse__btn purse__btn--dungeon" data-enter-dungeon title="Leave the table and descend into the dungeon to fight monsters for gold">🏋️ Hit the Dungeon</button></div>`;
      // 👁 Spectate — watch + heckle without leaving your seat or joining the
      // fight. Always offered; if nobody's delving the server says so. When a
      // run IS live we tag the button with who's down there.
      const watching = state.dungeonActive && state.dungeonSummary?.party?.length
        ? ` (${escapeText(state.dungeonSummary.party.join(', '))})` : '';
      const spectateRow = `<div class="purse__actions"><button type="button" class="purse__btn purse__btn--spectate" data-spectate-dungeon title="Watch the current dungeon run and heckle the delvers in chat">👁 Spectate the Dungeon${watching}</button></div>`;
      if (debt > 0) {
        const maxAffordable = Math.min(debt, chips);
        const smallPayment = Math.min(maxAffordable, 1000);
        // Render two buttons only if they'd be different amounts.
        const buttons = [];
        if (smallPayment >= 1) {
          buttons.push(`<button type="button" class="purse__btn" data-pay-debt="${smallPayment}">Pay ${formatChips(smallPayment)} gp</button>`);
        }
        if (maxAffordable > smallPayment) {
          buttons.push(`<button type="button" class="purse__btn purse__btn--max" data-pay-debt="${maxAffordable}">Pay ${formatChips(maxAffordable)} gp (max)</button>`);
        }
        const payBlock = buttons.length
          ? `<div class="purse__actions">${buttons.join('')}</div>`
          : `<div class="purse__hint">No chips to spare — keep playing.</div>`;
        pop.innerHTML = `
          <div class="purse__head">🏦 First Bank of Abadar</div>
          <div class="purse__row"><span>Chips on hand</span><span>${formatChips(chips)} gp</span></div>
          <div class="purse__row purse__row--debt"><span>Outstanding loan</span><span>${formatChips(debt)} gp</span></div>
          ${payBlock}
          <div class="purse__foot">Pay it down to clear the red dot from the leaderboard. Full settlement happens automatically on the next Loot Lord reset.</div>
          ${rebuyRow}
          ${dungeonRow}
          ${spectateRow}
        `;
        pop.classList.add('has-content');
      } else {
        pop.innerHTML = `
          <div class="purse__head">🏦 First Bank of Abadar</div>
          <div class="purse__row"><span>Chips on hand</span><span>${formatChips(chips)} gp</span></div>
          <div class="purse__row purse__row--clear"><span>Loan balance</span><span>—</span></div>
          <div class="purse__foot">You owe nothing. Abadar approves.</div>
          ${rebuyRow}
          ${dungeonRow}
          ${spectateRow}
        `;
        pop.classList.add('has-content');
      }
    }
  }

  // ===== Table render =====
  // ── Card-dealing animation ───────────────────────────────────────────
  // On the fresh PREFLOP deal, pitch two card-backs from the dealer's seat
  // out to every player in the hand — real-dealer order (one card to each
  // clockwise from the dealer's left, then a second pass), with a soft
  // flick per card. Purely cosmetic: the real face-down hole cards render
  // normally underneath and the flying backs fade out on landing.
  function _prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  }
  function spawnDealCard(overlay, ox, oy, tx, ty, delay, flight, withSound) {
    const W = 34, H = W * 106 / 70;
    const card = document.createElement('div');
    card.className = 'deal-card';
    card.innerHTML = window.FolkenCards.faceDown();
    card.style.left = (ox - W / 2) + 'px';
    card.style.top  = (oy - H / 2) + 'px';
    card.style.opacity = '0';
    overlay.appendChild(card);
    const dx = tx - ox, dy = ty - oy;
    const spin = (Math.random() * 36 - 18);  // a little flip/tumble
    let anim;
    try {
      anim = card.animate([
        { transform: 'translate(0,0) rotate(0deg) scale(.66)', opacity: 0.15 },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 16}px) rotate(${spin * 0.6}deg) scale(1.06)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${spin}deg) scale(1)`, opacity: 1 },
      ], { duration: flight, delay, easing: 'cubic-bezier(.25,.6,.3,1)', fill: 'forwards' });
    } catch (_) {
      // No Web Animations API — just drop the card at the target.
      card.style.transform = `translate(${dx}px, ${dy}px)`; card.style.opacity = '1';
    }
    // (Per-card flicks were aurally cluttered even at one-per-player; the deal
    // now uses a single composite sound played once in maybeDealAnimation.
    // `withSound` is retained so per-card audio can be re-enabled later.)
    void withSound;
    const cleanup = () => {
      try {
        const fade = card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'ease-out', fill: 'forwards' });
        fade.onfinish = () => card.remove();
      } catch (_) { card.remove(); }
      setTimeout(() => card.remove(), 320);  // safety
    };
    if (anim) anim.onfinish = cleanup; else setTimeout(cleanup, delay + flight);
  }
  function maybeDealAnimation(hand) {
    if (!hand || !hand.startedAt) return;
    if (hand.startedAt === _dealAnimLastHand) return;   // already handled this hand
    const boardLen = hand.board?.length || 0;
    const isPreflopDeal = (hand.state === 'PREFLOP') || boardLen === 0;
    // Mark as seen regardless, so a mid-hand reconnect doesn't animate late.
    _dealAnimLastHand = hand.startedAt;
    if (!isPreflopDeal) return;
    if (!_dealAnimEnabled || _prefersReducedMotion()) return;
    const overlay = $('#dealOverlay');
    const ring = $('#seatRing');
    const players = hand.players || [];
    if (!overlay || !ring || !players.length) return;

    // One composite deal sound for the whole pitch (honors the card mute) —
    // cleaner than per-card flicks overlapping.
    playFromPool(DEAL_POOL);

    // Defer one frame so the collision-avoidance rAF (queued just above)
    // has nudged seats into their final positions before we measure.
    requestAnimationFrame(() => {
      const overlayRect = overlay.getBoundingClientRect();
      if (!overlayRect.width) return;
      // Map rendered seat elements by player id.
      const seatByPid = {};
      for (const el of ring.children) {
        const pid = el.dataset && el.dataset.playerId;
        if (pid) seatByPid[pid] = el;
      }
      const N = players.length;
      const btn = Number.isInteger(hand.dealerButton) ? hand.dealerButton : 0;
      // Origin = the dealer's seat (fallback: ring center).
      const dealerEl = seatByPid[players[btn]?.playerId];
      const oRect = (dealerEl || ring).getBoundingClientRect();
      const ox = oRect.left + oRect.width / 2 - overlayRect.left;
      const oy = oRect.top  + oRect.height / 2 - overlayRect.top;
      // Deal order: player to the dealer's left (SB) first, clockwise,
      // dealer last — exactly how a live dealer pitches.
      const order = [];
      for (let k = 1; k <= N; k++) {
        const p = players[(btn + k) % N];
        const el = p && seatByPid[p.playerId];
        const hole = el && (el.querySelector('.seat__hole') || el.querySelector('.seat__plate') || el);
        if (hole) order.push(hole);
      }
      if (!order.length) return;
      const W = 34;
      let idx = 0;
      // Two passes — one card to each, then the second card. Timing constants
      // (DEAL_STAGGER/DEAL_FLIGHT) are shared with the hole-reveal schedule.
      for (let pass = 0; pass < 2; pass++) {
        for (const hole of order) {
          const r = hole.getBoundingClientRect();
          // Nudge the two cards apart so they land side-by-side, not stacked.
          const offset = (pass === 0 ? -W * 0.33 : W * 0.33);
          const tx = r.left + r.width / 2 - overlayRect.left + offset;
          const ty = r.top  + r.height / 2 - overlayRect.top;
          // One sound per player: only the first card (pass 0) plays a flick.
          spawnDealCard(overlay, ox, oy, tx, ty, idx * DEAL_STAGGER, DEAL_FLIGHT, pass === 0);
          idx++;
        }
      }
    });
  }

  // Build the reveal schedule at the START of a hand so renderTable can hide
  // each in-hand seat's hole cards until their flying card lands. Runs synchronously
  // (no DOM needed) so the first render of the new hand already hides them — no flash.
  function prepareDealReveal(hand) {
    if (!hand || !hand.startedAt) return;
    if (hand.startedAt === _dealRevealPrepHand) return;   // prepped this hand already
    _dealRevealPrepHand = hand.startedAt;
    _dealRevealMap = null; _dealRevealHand = null; _dealRevealUntil = 0;
    const boardLen = hand.board?.length || 0;
    const isPreflopDeal = (hand.state === 'PREFLOP') || boardLen === 0;
    if (!isPreflopDeal) return;
    if (!_dealAnimEnabled || _prefersReducedMotion()) return;
    const players = hand.players || [];
    const N = players.length;
    if (!N) return;
    const btn = Number.isInteger(hand.dealerButton) ? hand.dealerButton : 0;
    const order = [];
    for (let k = 1; k <= N; k++) {
      const p = players[(btn + k) % N];
      if (p && p.playerId) order.push(p.playerId);
    }
    if (!order.length) return;
    const base = Date.now();
    const map = new Map();
    order.forEach((pid, k) => {
      map.set(pid, [
        base + (k) * DEAL_STAGGER + DEAL_FLIGHT,                 // first card lands
        base + (order.length + k) * DEAL_STAGGER + DEAL_FLIGHT,  // second card lands
      ]);
    });
    _dealRevealMap = map;
    _dealRevealHand = hand.startedAt;
    _dealRevealUntil = base + order.length * 2 * DEAL_STAGGER + DEAL_FLIGHT + 300;
    // Timed reveals so cards appear on schedule even without a state event
    // between renders. revealDealtCard re-queries the live DOM each time.
    for (const [pid, lands] of map) {
      lands.forEach((t, ci) => setTimeout(() => revealDealtCard(pid, ci), Math.max(0, t - Date.now())));
    }
    // Safety net: clear the schedule + un-hide anything still hidden.
    setTimeout(() => {
      if (_dealRevealHand === hand.startedAt) { _dealRevealMap = null; _dealRevealHand = null; }
      document.querySelectorAll('.seat__hole .card-svg.card--predeal').forEach(el => el.classList.remove('card--predeal'));
    }, (_dealRevealUntil - base) + 150);
  }
  function revealDealtCard(pid, cardIdx) {
    const ring = $('#seatRing');
    if (!ring) return;
    const seat = [...ring.children].find(el => el.dataset && el.dataset.playerId === pid);
    if (!seat) return;
    const cards = seat.querySelectorAll('.seat__hole .card-svg');
    if (cards[cardIdx]) cards[cardIdx].classList.remove('card--predeal');
  }
  // Given a seat's two card HTML strings, hide (card--predeal) any whose flying
  // card hasn't landed yet, so they fade in on landing. No-op when no deal is
  // animating for the current hand.
  function applyDealPredeal(pid, cardArr, hand) {
    const predeal = (_dealRevealMap && hand && _dealRevealHand === hand.startedAt) ? _dealRevealMap.get(pid) : null;
    if (!predeal) return cardArr.join('');
    const now = Date.now();
    return cardArr.map((h, i) =>
      (i < predeal.length && now < predeal[i])
        ? h.replace('class="card-svg', 'class="card-svg card--predeal')
        : h
    ).join('');
  }

  function renderTable() {
    const t = state.table; if (!t) return;
    renderRecords();   // sidebar "Hall of Records" (biggest single-hand win/loss)
    const hand = t.hand;
    // Fire shuffle/deal SFX based on hand + board transitions. Cheap
    // no-op when nothing changed (compares cached timestamps).
    maybePlayCardSounds(hand);
    // Build the deal-reveal schedule BEFORE seats render, so in-hand hole
    // cards start hidden and fade in as their flying card lands.
    prepareDealReveal(hand);
    const ring = $('#seatRing');
    ring.innerHTML = '';
    const n = t.seats.length;
    const myId = state.me?.player_id;

    t.seats.forEach((seat, i) => {
      // Position seats on an ellipse around the center (board/pot/stage).
      // ry was originally 33 (very flat) but adjacent side-seats overlapped
      // each other vertically. 38 spreads them enough that their plates
      // breathe without pushing the corner seats off the felt.
      const angle = (Math.PI * 2 * i) / n + Math.PI / 2;
      const cx = 50 + Math.cos(angle) * 44;
      const cy = 50 + Math.sin(angle) * 38;
      const isBottomHalf = cy > 50;
      const el = document.createElement('div');
      const isMe = seat.occupied && seat.playerId === myId;
      const handPlayer = hand?.players?.find(p => p.playerId === seat.playerId);
      const isActor = hand && hand.actor && hand.actor === seat.playerId;
      const isFolded = !!handPlayer?.folded;
      const isAllIn = !!handPlayer?.allIn;

      const classes = ['seat'];
      classes.push(seat.occupied ? 'is-taken' : 'is-empty');
      if (isMe) classes.push('is-me');
      if (isActor) classes.push('is-acting');
      if (isFolded) classes.push('is-folded');
      if (seat.isAfk) classes.push('is-afk');
      if (isBottomHalf) classes.push('seat--bottom');
      el.className = classes.join(' ');
      el.style.left = cx + '%'; el.style.top = cy + '%';
      // Tag occupied seats with their player id so the deal animation can
      // locate the dealer seat (origin) and each target hole after render.
      if (seat.occupied && seat.playerId) el.dataset.playerId = seat.playerId;

      if (seat.occupied) {
        // Determine hole-card display
        let holeHtml = '';
        if (handPlayer) {
          let cards = null;
          if (isMe && state.myHole) cards = state.myHole;
          else if (handPlayer.hole) cards = handPlayer.hole;  // exposed at showdown
          if (cards) {
            const cardArr = cards.map(c => window.FolkenCards.card(c).replace('class="card-svg"', 'class="card-svg ' + (isMe ? 'card-svg--mine' : '') + '"'));
            holeHtml = `<div class="seat__hole">${applyDealPredeal(seat.playerId, cardArr, hand)}</div>`;
          } else if (!isFolded) {
            const cardArr = [window.FolkenCards.faceDown(), window.FolkenCards.faceDown()];
            holeHtml = `<div class="seat__hole">${applyDealPredeal(seat.playerId, cardArr, hand)}</div>`;
          }
        } else if (hand) {
          // Seated but NOT in the current hand (joined mid-hand). Make this
          // clear so the player isn't confused about "where are my cards".
          holeHtml = `<div class="seat__waiting">Waiting · next hand</div>`;
        }
        // Determine badge (D, SB, BB)
        let badge = '';
        if (hand) {
          const pIdx = hand.players.findIndex(p => p.playerId === seat.playerId);
          if (pIdx === hand.dealerButton) badge = 'D';
          else if (pIdx === hand.sbIndex) badge = 'SB';
          else if (pIdx === hand.bbIndex) badge = 'BB';
        }
        const badgeHtml = badge ? `<div class="seat__badge">${badge}</div>` : '';
        // Bet display
        const betHtml = handPlayer?.invested
          ? `<div class="seat__bet">bet ${formatChips(handPlayer.invested)}</div>` : '';

        // AI badge is now an avatar-corner overlay (see below) — no
        // longer a line of body text. Inline pills stay for the
        // edge-case statuses: AFK (disconnected) and SIT-OUT (user
        // chose to skip deals).
        const botTag = seat.sittingOut
          ? `<span class="seat__afk-tag" title="Sat out — skipping deals until they Rejoin">sitting out</span>`
          : (!seat.isBot && seat.isAfk
              ? `<span class="seat__afk-tag" title="Disconnected — sitting out until they return">AFK</span>`
              : '');
        const avatarBadge = seat.controlledHuman
          ? `<span class="seat__avatar-ai" style="background:#2e7d32;border-color:#43a047" title="Human-controlled">${escapeText(seat.controllerName || 'Human')}</span>`
          : seat.isBot
            ? `<span class="seat__avatar-ai" title="AI player">AI</span>`
            : '';
        // Subtle intelligence-tier ring on AI tokens — bronze = low,
        // silver = average, gold = high. Intelligence comes from the roster
        // broadcast (state.roster carries bot_intelligence). Humans keep the
        // default brass frame.
        let intelClass = '';
        if (seat.isBot) {
          const rp = (state.roster || []).find(r => r.player_id === seat.playerId);
          const it = rp && rp.bot_intelligence;
          if (it === 'high')         intelClass = ' seat__avatar--intel-high';
          else if (it === 'average') intelClass = ' seat__avatar--intel-avg';
          else if (it === 'low')     intelClass = ' seat__avatar--intel-low';
        }
        // Per-seat kick button. Any seated player can click × on any OTHER
        // occupied seat (human or bot) to kick them — takes effect at end
        // of the current hand, and posts a chat line naming who kicked
        // whom. The pendingStand label shows once the kick is queued.
        const canKick = state.me && seat.playerId !== state.me.player_id;
        const removeBotHtml = canKick
          ? (seat.pendingStand
              ? `<span class="seat__leaving" title="Leaves at end of current hand">leaving after hand</span>`
              : `<button type="button" class="seat__remove" data-kick-player="${escapeAttr(seat.playerId)}" title="Kick ${escapeAttr(seat.nickname)} — takes effect at end of this hand">×</button>`)
          : '';
        // Per-seat FIGHT button (cosmetic gag). Only when I'm seated and the
        // target is someone else — hover the seat to reveal the ⚔️. Purely
        // flavor: it never affects chips or the hand.
        const canFight = state.me && seat.playerId !== state.me.player_id
          && t.seats.some(s => s.occupied && s.playerId === state.me.player_id);
        const pid = escapeAttr(seat.playerId);
        const tnick = escapeAttr(seat.nickname);
        const fightBtnHtml = canFight
          ? `<div class="seat__attacks">`
            + `<button type="button" class="seat__fight" data-fight-player="${pid}" data-attack="melee" title="Melee — swing your weapon at ${tnick}">⚔️</button>`
            + `<button type="button" class="seat__fight seat__fight--bolt" data-fight-player="${pid}" data-attack="lightning" title="Lightning Bolt at ${tnick} (Reflex save)">⚡</button>`
            + `<button type="button" class="seat__fight seat__fight--stink" data-fight-player="${pid}" data-attack="stinking" title="Stinking Cloud on ${tnick} (Fort save)">💨</button>`
            + `</div>`
          : '';
        const sickenedHtml = (seat.sickenedUntil && seat.sickenedUntil > Date.now())
          ? `<span class="seat__sickened" title="Sickened — failed a Stinking Cloud save">🤢</span>`
          : '';
        // Action timer countdown — shown on ANY acting seat now (human
        // OR bot). Tag with data-seat-timer-bot so tickTimers can label
        // it differently for bots ("thinking…") vs humans ("⏱ 0:42").
        const showTimer = isActor && t.actionDeadline;
        const timerHtml = showTimer
          ? `<div class="seat__timer" data-deadline="${t.actionDeadline}" data-seat-timer data-seat-timer-bot="${seat.isBot ? '1' : '0'}"></div>`
          : '';
        // Compact gear summary on the seat plate — small icons + total
        // value. Full bank UI is the bottom-right widget.
        const seatGear = seat.gear || {};
        const seatGearTotal = seat.gearValue || 0;
        const gearIconsHtml = renderSeatGearStrip(seatGear, seatGearTotal);
        // Keep the variable from the old code path to avoid touching every
        // template literal — bank renders gear separately now.
        let swordsHtml = gearIconsHtml;
        // No more in-seat action panel — it lives in #actpanelHost.
        const actionPanelHtml = '';
        // myTurn used by .seat__plate--acting class below.
        const myTurn = isMe && isActor && handPlayer && !handPlayer.folded && !handPlayer.allIn
          && hand.state !== 'SHOWDOWN' && hand.state !== 'COMPLETE';
        // removeBotHtml, badgeHtml, and swordsHtml (gear popup) live
        // OUTSIDE seat__plate so they aren't clipped by the plate's
        // overflow:hidden (which exists to enforce max-height for
        // overlap prevention). They anchor to .seat itself — gear pops
        // up below the plate on hover; badges anchor at the corners.
        el.innerHTML = `
          ${removeBotHtml}
          ${fightBtnHtml}
          ${sickenedHtml}
          ${badgeHtml}
          ${swordsHtml}
          <div class="seat__plate ${myTurn ? 'seat__plate--acting' : ''}">
            <div class="seat__avatar${intelClass}">${renderAvatar(seat.avatarId)}${avatarBadge}${seat.crowned ? `<span class="seat__crown" title="Loot Lord — assembled a full +5 set" style="position:absolute;top:-9px;left:50%;transform:translateX(-50%);font-size:1.15em;line-height:1;z-index:6;pointer-events:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.7))">👑</span>` : ''}</div>
            <div class="seat__nick" title="${escapeAttr(seat.nickname)}">${escapeText(seat.nickname)}${isAllIn ? ' · ALL-IN' : ''}</div>
            ${botTag}
            <div class="seat__chips">💰 ${formatChips(handPlayer ? handPlayer.stack : seat.chips)} gp</div>
            ${betHtml}
            ${timerHtml}
            ${holeHtml}
            ${actionPanelHtml}
          </div>`;
      } else {
        // Empty seat = a real, focusable button so a screen reader can
        // land on it and announce "Sit down in seat N, button". A bare
        // clickable <div> (the old markup) is invisible to AT and was
        // hard for blind players to select. role/tabindex/aria + Enter
        // and Space activation give full keyboard + SR operability.
        el.innerHTML = `
          <div class="seat__plate seat__plate--empty" role="button" tabindex="0"
               aria-label="Sit down in seat ${seat.index + 1}" title="Sit here">
            <div class="seat__empty">Sit ${seat.index + 1}</div>
          </div>`;
        const plate = el.querySelector('.seat__plate');
        const sit = () => sitDown(seat.index);
        plate.addEventListener('click', sit);
        plate.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ' || ev.code === 'Space') {
            ev.preventDefault();
            sit();
          }
        });
      }
      ring.appendChild(el);
    });

    // ----- Collision-avoidance pass -----
    // After all seats are placed via percentage-based (cx, cy), measure
    // their actual pixel rects and nudge any pair that overlaps along
    // their connecting line until they clear. Iterates a few times so
    // multi-seat clusters settle. The CSS max-height on .seat already
    // caps growth; this is the last-line-of-defense for the cramped
    // side-rail positions where vertical centers are only ~150 px apart.
    requestAnimationFrame(() => {
      const seatEls = [...ring.children];
      const ringRect = ring.getBoundingClientRect();
      const PAD = 6;  // breathing-space px between plates
      const MAX_PASSES = 4;
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        let anyMoved = false;
        const rects = seatEls.map(e => e.getBoundingClientRect());
        for (let i = 0; i < seatEls.length; i++) {
          for (let j = i + 1; j < seatEls.length; j++) {
            const a = rects[i], b = rects[j];
            const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (overlapX <= -PAD || overlapY <= -PAD) continue;
            // Push apart along the line between centers. Resolve along
            // the SHORTER overlap dimension for minimal disturbance.
            const ax = (a.left + a.right) / 2, ay = (a.top + a.bottom) / 2;
            const bx = (b.left + b.right) / 2, by = (b.top + b.bottom) / 2;
            const dx = bx - ax, dy = by - ay;
            const dist = Math.hypot(dx, dy) || 1;
            const need = (Math.abs(overlapX) < Math.abs(overlapY))
              ? overlapX + PAD
              : overlapY + PAD;
            const nudge = need / 2;
            const ux = (dx / dist) * nudge;
            const uy = (dy / dist) * nudge;
            // Apply nudges by adjusting % position relative to the ring.
            const ringW = ringRect.width || 1, ringH = ringRect.height || 1;
            const ax_pct = parseFloat(seatEls[i].style.left) - (ux / ringW * 100);
            const ay_pct = parseFloat(seatEls[i].style.top)  - (uy / ringH * 100);
            const bx_pct = parseFloat(seatEls[j].style.left) + (ux / ringW * 100);
            const by_pct = parseFloat(seatEls[j].style.top)  + (uy / ringH * 100);
            seatEls[i].style.left = ax_pct + '%';
            seatEls[i].style.top  = ay_pct + '%';
            seatEls[j].style.left = bx_pct + '%';
            seatEls[j].style.top  = by_pct + '%';
            anyMoved = true;
          }
        }
        if (!anyMoved) break;
      }
    });

    // Card-dealing animation — fires once on the fresh PREFLOP deal. Runs
    // after the collision pass (queued later) so it reads settled seat
    // positions. Reads `hand` + the just-rendered seat DOM.
    maybeDealAnimation(hand);

    // Community board
    const board = $('#board');
    board.innerHTML = '';
    const dealt = hand?.board || [];
    const totalSlots = hand ? 5 : 0;
    for (let i = 0; i < totalSlots; i++) {
      if (dealt[i]) board.insertAdjacentHTML('beforeend', window.FolkenCards.card(dealt[i]));
      else board.insertAdjacentHTML('beforeend', window.FolkenCards.emptySlot());
    }

    // Pot + stage
    const potTotal = hand?.potTotal || 0;
    $('#pot').textContent = 'Pot ' + formatGp(potTotal);
    $('#pot').style.opacity = hand ? 1 : 0.3;

    const seated = t.seats.filter(s => s.occupied).length;
    const stage = hand ? hand.state : 'WAITING';
    $('#stageBanner').textContent = stageLabel(stage, seated, t.spectatorCount);

    // Spectators (connected but not seated) in the top bar, between the
    // clock and the user profile — rendered as tokens, falling back to
    // comma-joined names when the tokens don't fit the slot.
    renderSpectators(t.spectators);

    // Winner banner
    renderWinnerBanner(hand);

    // Action bar
    renderActionBar(hand);

    // Replace the chat-log render with whatever the server snapshot has.
    // Subsequent `table:chat` events append incrementally without a full redo.
    if (Array.isArray(t.chatLog)) renderChatLog(t.chatLog);

    // Fire the timer text once immediately (otherwise it'd show blank for ~1s).
    tickTimers();

    // The action panel + gear bank live OUTSIDE the seat ring so they
    // survive these full-DOM re-renders. We just refresh their inner
    // content here.
    renderActionPanel();
    renderBank();
    renderSidebarBank();   // left-side gear/purchase column reflects live chip totals
    renderLootLord();

    // Re-apply the saved action-panel drag offset. The panel host element
    // itself is permanent now, but its inline CSS vars can get cleared
    // when innerHTML is set inside it — re-apply defensively.
    applyActpanelOffset();
  }

  // ===== Gear bank (bottom-right of felt) =====
  const GEAR_SVGS = {
    weapon: '<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4l5 5-9 9-5-5z"/><path d="M9 11l4 4"/><path d="M4 20l3-3"/></svg>',
    armor:  '<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>',
    shield: '<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/><path d="M9 11l2 2 4-4"/></svg>',
    cloak:  '<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l-3 7 4 2v9h10v-9l4-2-3-7"/><path d="M9 4c0 2 1 3 3 3s3-1 3-3"/></svg>',
    ring:   '<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="15" r="5"/><path d="M9 7l-2-4h10l-2 4"/></svg>',
  };
  // PF1e price formulas, mirrored from backend so we can compute upgrade
  // costs without a round-trip. Keep in sync with db.js GEAR_SLOTS.
  // `short` is the column label used in the bank UI.
  const GEAR_META = {
    weapon: { label: 'Weapon', short: 'Weapon', mw: 315,  mult: 2000 },
    armor:  { label: 'Armor',  short: 'Armor',  mw: 1650, mult: 1000 },
    shield: { label: 'Shield', short: 'Shield', mw: 170,  mult: 1000 },
    cloak:  { label: 'Cloak of Resistance',    short: 'Cloak',  mw: 0,    mult: 1000 },
    ring:   { label: 'Ring of Protection',     short: 'Ring',   mw: 0,    mult: 2000 },
  };
  const GEAR_SLOTS = ['weapon', 'armor', 'shield', 'cloak', 'ring'];
  function gearPrice(slot, tier) {
    const m = GEAR_META[slot];
    if (!m || tier < 1 || tier > 5) return 0;
    return m.mw + tier * tier * m.mult;
  }
  /** Compact strip of the gear icons a player owns, shown under their
   *  chip count. Greys out empty slots. Highlights +5. */
  function renderSeatGearStrip(gear, total) {
    if (!gear) return '';
    const cells = GEAR_SLOTS.map(slot => {
      const tier = gear[slot] || 0;
      if (!tier) {
        const t = slot === 'armor' ? 'Masterwork armor (your class baseline) — no magic enhancement yet' : `${GEAR_META[slot].label}: not owned`;
        return `<span class="seat__gear-cell seat__gear-cell--empty" title="${t}">${GEAR_SVGS[slot]}</span>`;
      }
      const cls = tier === 5 ? 'seat__gear-cell--max' : '';
      return `<span class="seat__gear-cell ${cls}" title="+${tier} ${GEAR_META[slot].label}">${GEAR_SVGS[slot]}<sup>+${tier}</sup></span>`;
    }).join('');
    const totalStr = total ? `<span class="seat__gear-total" title="Total gear value">${formatChips(total)} gp</span>` : '';
    return `<div class="seat__gear">${cells}${totalStr}</div>`;
  }

  const LOOT_LORD_TOTAL = 177135;   // +5 in all 5 slots, PF1e prices

  /** Build the bank rows + progress HTML — used inline inside the
   *  action panel when state.actpanelSection === 'bank'. */
  function buildBankHtml() {
    if (!state.me) return '';
    const t = state.table;
    const mySeat = t?.seats?.find(s => s.playerId === state.me.player_id);
    // Prefer the live seat data (mid-hand updates), but fall back to the
    // roster record when not currently seated — that record carries the
    // persisted gear JSON so the bank doesn't go blank between hands or
    // while sitting out.
    let gear = mySeat?.gear;
    if (!gear) {
      try { gear = JSON.parse(state.me.gear || '{}') || {}; }
      catch (_) { gear = {}; }
    }
    const chips = mySeat?.chips ?? state.me.chips ?? 0;

    const rows = GEAR_SLOTS.map(slot => {
      const cur = gear[slot] || 0;
      const meta = GEAR_META[slot];
      const next = cur < 5 ? cur + 1 : null;
      const upgradeCost = next ? gearPrice(slot, next) - (cur ? gearPrice(slot, cur) : 0) : 0;
      const canAfford = upgradeCost > 0 && chips >= upgradeCost;
      const sellValue = cur ? Math.floor(gearPrice(slot, cur) / 2) : 0;
      const tierBadge = cur
        ? `<span class="bank__tier bank__tier--${cur===5?'max':'on'}">+${cur}</span>`
        : (slot === 'armor'
            ? `<span class="bank__tier bank__tier--off" title="Masterwork armor — your class baseline; buy +N to add a magic enhancement">MW</span>`
            : `<span class="bank__tier bank__tier--off">—</span>`);
      const upgradeBtn = next
        ? `<button type="button" class="bank__btn bank__btn--buy" ${canAfford?'':'disabled'} data-buy-slot="${slot}" data-buy-tier="${next}" title="${cur?'Upgrade to':'Buy a'} +${next} ${meta.label} for ${upgradeCost.toLocaleString()} gp">${cur?'+':'Buy +'}${next}<br><small>${formatChips(upgradeCost)} gp</small></button>`
        : `<button type="button" class="bank__btn bank__btn--max" disabled title="Maxed">+5 ✓</button>`;
      const sellBtn = cur
        ? `<button type="button" class="bank__btn bank__btn--sell" data-sell-slot="${slot}" title="Hock for ${sellValue.toLocaleString()} gp (50% market)">Hock<br><small>+${formatChips(sellValue)}</small></button>`
        : '';
      return `
        <div class="bank__row">
          <div class="bank__icon" title="${meta.label}">${GEAR_SVGS[slot]}</div>
          <div class="bank__label">${meta.short}</div>
          ${tierBadge}
          <div class="bank__actions">${upgradeBtn}${sellBtn}</div>
        </div>`;
    }).join('');

    const totalValue = GEAR_SLOTS.reduce((sum, slot) => {
      const t = gear[slot] || 0;
      return sum + (t ? gearPrice(slot, t) : 0);
    }, 0);
    const progressPct = Math.min(100, Math.round((totalValue / LOOT_LORD_TOTAL) * 100));

    // (The Abadar-debt readout + pay-down buttons live in the hover
    // popover off the topbar #meChips badge, not in this panel. Keeps
    // the gear bank focused on gear.)

    return `
      <div class="bank">
        ${rows}
        <div class="bank__progress" title="Progress to LOOT LORD (full +5 set)">
          <div class="bank__progress-bar" style="width:${progressPct}%"></div>
          <span class="bank__progress-text">${formatChips(totalValue)} / ${formatChips(LOOT_LORD_TOTAL)} · ${progressPct}%</span>
        </div>
      </div>`;
  }

  /** Wealth ranking — chips + total gear value, descending. Returns HTML.
   *  Pulls from state.roster (which carries all humans + bots after the
   *  lobby:roster broadcast). Top 10 only — keeps the panel compact. */
  function buildLeaderboardHtml() {
    const all = (state.roster || []).slice();
    const meId = state.me?.player_id;
    // NET POKER RESULT — money won minus money lost across every logged hand
    // (server-computed from hands.jsonl; survives restarts, resets with the
    // records era). Ranks RESULTS, not bankroll: a loan from Abadar or a
    // dungeon haul doesn't move this board — only poker does.
    function scoreOf(p) { return Number(p.pokerNet || 0); }
    const ranked = all
      .map(p => ({ p, net: scoreOf(p) }))
      .filter(({ p }) => Number(p.pokerHands || 0) > 0)   // never dealt a hand → off the board
      .sort((a, b) => b.net - a.net)
      .slice(0, 10);

    const rows = ranked.map((row, i) => {
      const p = row.p;
      const mine = p.player_id === meId ? 'is-me' : '';
      const rankMedal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i+1) + '.';
      const lord = p.is_bot ? 'AI' : '';
      // Red dot ⏺ next to indebted players so others know why they're
      // ranked low. Exact amount only shown to the player themselves
      // (see buildBankHtml). Tooltip differs accordingly.
      const debt = Number(p.rebuy_debt || 0);
      const isMine = p.player_id === meId;
      const debtDot = debt > 0
        ? `<span class="lb__debt" title="${isMine ? ('Owe '+debt.toLocaleString()+' gp to the First Bank of Abadar') : 'In debt to the First Bank of Abadar'}">●</span>`
        : '';
      return `
        <li class="lb__row ${mine}">
          <span class="lb__rank">${rankMedal}</span>
          <span class="lb__avatar">${renderAvatar(p.avatar_id)}</span>
          <span class="lb__name">${escapeText(p.nickname)}${lord?'<span class="lb__bot">'+lord+'</span>':''}${debtDot}</span>
          <span class="lb__wealth" style="${row.net < 0 ? 'color:#cc5544' : ''}" title="poker won − lost over ${Number(p.pokerHands || 0).toLocaleString()} hands · cash on hand ${formatChips(p.chips || 0)} gp">${row.net < 0 ? '−' : '+'}${formatChips(Math.abs(row.net))} gp</span>
        </li>`;
    }).join('');
    return `<ol class="lb">${rows}</ol>`;
  }

  /** Refresh the right-side perimeter leaderboard. Same data as the
   *  in-actpanel leaderboard but always visible. */
  // "Hall of Records" under the leaderboard — all-time per-hand extremes
  // (server-tracked in state.table.records, split into all/human/ai). The
  // filter buttons pick which population to show.
  // Both the leaderboard and the Hall of Records default to HUMANS-only, and
  // remember the player's choice across sessions (localStorage).
  const _prefGet = (k, dflt) => { try { return localStorage.getItem(k) || dflt; } catch (_) { return dflt; } };
  const _prefSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  let _recordsFilter = _prefGet('fp_recFilter', 'human');
  function renderRecords() {
    const recs = (state.table && state.table.records) || {};
    // Back-compat: older servers sent a flat object (no all/human/ai split).
    const r = recs[_recordsFilter] || recs.all || recs;
    // id, label, record, value-formatter, optional color class
    const ROWS = [
      ['#recordBiggestWin',   '🥇 Gain',   r.biggestWin,    (x) => '+' + formatChips(x.amount), 'is-win'],
      ['#recordBiggestLoss',  '💀 Loss',   r.biggestLoss,   (x) => '−' + formatChips(x.amount), 'is-loss'],
      ['#recordBiggestPot',   '💰 Pot',    r.biggestPot,    (x) => formatChips(x.amount), ''],
      ['#recordLongestWar',   '⚔️ War',    r.longestWar,    (x) => x.count + ' raises', ''],
      ['#recordBiggestBluff', '🃏 Bluff',  r.biggestBluff,  (x) => formatChips(x.amount), 'is-win'],
      ['#recordUgliestWin',   '🐟 Ugliest', r.ugliestWinner, (x) => escapeText(String(x.hand || '').split(',')[0]), ''],
    ];
    for (const [id, label, rec, valFn, cls] of ROWS) {
      const el = $(id);
      if (!el) continue;
      // Skip identical re-writes — DOM churn here stranded the VoiceOver cursor.
      const put = (html) => { if (el._lastHtml !== html) { el._lastHtml = html; el.innerHTML = html; } };
      if (!rec) {
        put(`<span class="lb-records__label">${label}</span><span class="lb-records__empty">—</span>`);
        continue;
      }
      const when = rec.ts ? new Date(rec.ts).toLocaleDateString() : '';
      const tip = `${rec.nick}${rec.hand ? ' · ' + rec.hand : ''}${when ? ' · ' + when : ''}`;
      put(`<span class="lb-records__label">${label}</span>`
        + `<span class="lb-records__who" title="${escapeAttr(tip)}">${escapeText(rec.nick)}</span>`
        + `<span class="lb-records__amt ${cls}">${valFn(rec)}</span>`);
    }
  }
  // Hu / All filter for the Hall of Records (remembers the choice).
  function _syncRecFilterButtons() {
    $('#sidebarRecords')?.querySelectorAll('[data-rec-filter]').forEach(x => x.classList.toggle('is-active', x.dataset.recFilter === _recordsFilter));
  }
  $('#sidebarRecords')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rec-filter]');
    if (!b) return;
    _recordsFilter = b.dataset.recFilter || 'human';
    _prefSet('fp_recFilter', _recordsFilter);
    _syncRecFilterButtons();
    renderRecords();
  });
  _syncRecFilterButtons();   // reflect the stored preference on load

  // Hu / All filter for the leaderboard (remembers the choice).
  let _lbFilter = _prefGet('fp_lbFilter', 'human');
  function _syncLbFilterButtons() {
    $('#sidebarLbFilter')?.querySelectorAll('[data-lb-filter]').forEach(x => x.classList.toggle('is-active', x.dataset.lbFilter === _lbFilter));
  }
  $('#sidebarLbFilter')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lb-filter]');
    if (!b) return;
    _lbFilter = b.dataset.lbFilter || 'human';
    _prefSet('fp_lbFilter', _lbFilter);
    _syncLbFilterButtons();
    renderSidebarLeaderboard();
  });
  _syncLbFilterButtons();

  function renderSidebarLeaderboard() {
    const el = $('#sidebarLeaderboard');
    if (!el) return;
    // Only touch the DOM when the board actually CHANGED. Rebuilding identical
    // HTML every broadcast yanked the rug out from under VoiceOver — the
    // cursor got stranded on dead nodes and the macOS Item Chooser went blind.
    const put = (html) => { if (el._lastHtml !== html) { el._lastHtml = html; el.innerHTML = html; } };
    const all = (state.roster || []).slice();
    if (all.length === 0) { put('<li class="lb__empty">No players yet…</li>'); return; }
    const meId = state.me?.player_id;
    // NET POKER RESULT — won minus lost across every logged hand (server-fed
    // pokerNet; same metric as the popup board). Loans, gear and dungeon gold
    // don't move this board — only poker results do.
    function scoreOf(p) { return Number(p.pokerNet || 0); }
    const ranked = all
      .map(p => ({ p, net: scoreOf(p) }))
      .filter(({ p }) => Number(p.pokerHands || 0) > 0)      // never dealt a hand → off the board
      .filter(({ p }) => _lbFilter === 'all' || !p.is_bot)   // Hu = humans only (default)
      .sort((a, b) => b.net - a.net);
    if (!ranked.length) { put(`<li class="lb__empty">${_lbFilter === 'all' ? 'No players yet…' : 'No human players yet…'}</li>`); return; }
    put(ranked.map((row, i) => {
      const p = row.p;
      const mine = p.player_id === meId ? 'is-me' : '';
      const rankMedal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i+1) + '.';
      const lord = p.is_bot ? '<span class="lb__bot">AI</span>' : '';
      const debt = Number(p.rebuy_debt || 0);
      const isMine = p.player_id === meId;
      const debtDot = debt > 0
        ? `<span class="lb__debt" title="${isMine ? ('Owe '+debt.toLocaleString()+' gp to the First Bank of Abadar') : 'In debt to the First Bank of Abadar'}">●</span>`
        : '';
      return `
        <li class="lb__row ${mine}">
          <span class="lb__rank">${rankMedal}</span>
          <span class="lb__avatar">${renderAvatar(p.avatar_id)}</span>
          <span class="lb__name">${escapeText(p.nickname)}${lord}${debtDot}</span>
          <span class="lb__wealth" style="${row.net < 0 ? 'color:#cc5544' : ''}" title="poker won − lost over ${Number(p.pokerHands || 0).toLocaleString()} hands · cash ${formatChips(p.chips || 0)} gp">${row.net < 0 ? '−' : '+'}${formatChips(Math.abs(row.net))}</span>
        </li>`;
    }).join(''));
  }

  // ===== Loot Bank "paper doll" popover =====
  // The "🎒 My Loot Bank" button stays collapsed; clicking it pops up a paper
  // doll of the player's equipped gear (buy / hock per slot). Dismisses on a
  // click outside, the ✕, or Escape.
  let _bankDollOpen = false;
  let _bankOpener = null;   // the toggle that opened the doll — focus returns here on close
  // A compact equipment-slot card: icon + tier badge + buy/hock buttons.
  function bankSlotCard(slot, gear, chips) {
    const meta = GEAR_META[slot];
    const cur = gear[slot] || 0;
    const next = cur < 5 ? cur + 1 : null;
    const upgradeCost = next ? gearPrice(slot, next) - (cur ? gearPrice(slot, cur) : 0) : 0;
    const canAfford = upgradeCost > 0 && chips >= upgradeCost;
    const sellValue = cur ? Math.floor(gearPrice(slot, cur) / 2) : 0;
    const tierTxt = cur ? `+${cur}` : (slot === 'armor' ? 'Chain' : '—');
    const tierCls = cur === 5 ? 'is-max' : cur ? 'is-on' : 'is-off';
    const buyBtn = next
      ? `<button type="button" class="bank__btn bank__btn--buy" ${canAfford ? '' : 'disabled'} data-buy-slot="${slot}" data-buy-tier="${next}" aria-label="${cur ? 'Upgrade to' : 'Buy'} +${next} ${meta.label}, ${upgradeCost.toLocaleString()} gold${canAfford ? '' : ' — not enough gold'}" title="${cur ? 'Upgrade to' : 'Buy a'} +${next} ${meta.label} — ${upgradeCost.toLocaleString()} gp">${cur ? '⬆ +' : 'Buy +'}${next} · ${formatChips(upgradeCost)}</button>`
      : `<button type="button" class="bank__btn bank__btn--max" disabled aria-label="${meta.label} at maximum, plus 5">+5 ✓</button>`;
    const sellBtn = cur
      ? `<button type="button" class="bank__btn bank__btn--sell" data-sell-slot="${slot}" aria-label="Hock +${cur} ${meta.label} for ${sellValue.toLocaleString()} gold" title="Hock for ${sellValue.toLocaleString()} gp (50% market)">Hock +${formatChips(sellValue)}</button>`
      : '';
    return `<div class="doll-slot">
        <div class="doll-slot__icon" title="${meta.label}">${GEAR_SVGS[slot]}<span class="doll-slot__tier ${tierCls}">${tierTxt}</span></div>
        <div class="doll-slot__label">${meta.short}</div>
        <div class="doll-slot__btns">${buyBtn}${sellBtn}</div>
      </div>`;
  }
  function buildPaperDollHtml() {
    const head = `<div class="bank-doll__head"><span>🎒 My Loot Bank</span><button type="button" class="bank-doll__close" data-bank-close aria-label="Close">✕</button></div>`;
    if (!state.me) return head + '<p class="sidebar-bank__empty">Pick a character to start your collection.</p>';
    const mySeat = state.table?.seats?.find(s => s.playerId === state.me.player_id);
    let gear = mySeat?.gear;
    if (!gear) { try { gear = JSON.parse(state.me.gear || '{}') || {}; } catch (_) { gear = {}; } }
    const chips = mySeat?.chips ?? state.me.chips ?? 0;
    const totalValue = GEAR_SLOTS.reduce((s, slot) => s + ((gear[slot] || 0) ? gearPrice(slot, gear[slot]) : 0), 0);
    const pct = Math.min(100, Math.round(totalValue / LOOT_LORD_TOTAL * 100));
    const avatar = renderAvatar(state.me.avatar_id || mySeat?.avatarId);
    const c = (s) => bankSlotCard(s, gear, chips);
    return head + `
      <div class="bank-doll__grid">
        <div class="bank-doll__col">${c('weapon')}${c('armor')}</div>
        <div class="bank-doll__figure"><div class="bank-doll__avatar">${avatar}</div><div class="bank-doll__chips">💰 ${formatChips(chips)} gp</div></div>
        <div class="bank-doll__col">${c('shield')}${c('cloak')}</div>
      </div>
      <div class="bank-doll__ringrow">${c('ring')}</div>
      <div class="bank__progress" title="Progress to LOOT LORD (full +5 set)"><div class="bank__progress-bar" style="width:${pct}%"></div><span class="bank__progress-text">${formatChips(totalValue)} / ${formatChips(LOOT_LORD_TOTAL)} · ${pct}%</span></div>`;
  }
  // Both the table sidebar button and the dungeon header button open the same
  // (top-level, position:fixed) popover; we anchor it under whichever was used.
  const _bankToggles = () => [$('#sidebarBankToggle'), $('#dungeonBankToggle')].filter(Boolean);
  function openBankDoll(btn) {
    const el = $('#bankDoll'); if (!el) return;
    _bankDollOpen = true; el.hidden = false; el.innerHTML = buildPaperDollHtml();
    // Anchor (fixed) just below the button, clamped so it can't run off-screen
    // (the dungeon button sits on the right side of its header).
    const anchor = btn || $('#dungeonBankToggle') || $('#sidebarBankToggle');
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      el.style.top = `${Math.round(r.bottom + 6)}px`;
      el.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 312)))}px`;
    }
    _bankToggles().forEach(b => b.setAttribute('aria-expanded', 'true'));
    // Accessibility: move keyboard/screen-reader focus INTO the dialog so it can
    // be tabbed through (it lives at the end of the DOM, far from the toggle).
    _bankOpener = anchor || null;
    const first = el.querySelector('button:not([disabled]), [href], input, select, [tabindex]:not([tabindex="-1"])');
    if (first) { try { first.focus(); } catch (_) {} }
  }
  function closeBankDoll() {
    const el = $('#bankDoll'); if (el) el.hidden = true;
    _bankDollOpen = false;
    _bankToggles().forEach(b => b.setAttribute('aria-expanded', 'false'));
    // Return focus to whichever toggle opened it (Escape / ✕ / outside-click).
    if (_bankOpener) { try { _bankOpener.focus(); } catch (_) {} _bankOpener = null; }
  }
  // Re-render the open doll when chips/gear change — PRESERVING which control was
  // focused, so a keyboard/SR user isn't kicked out when the table state updates.
  let _bankDirty = false;   // a rebuild was skipped while the user was inside the bank
  function renderSidebarBank(force = false) {
    if (!_bankDollOpen) return;
    const el = $('#bankDoll'); if (!el) return;
    const a = document.activeElement;
    const focusedInside = !!(a && el.contains(a));
    const html = buildPaperDollHtml();
    if (html === el.innerHTML) { _bankDirty = false; return; }   // nothing changed — leave the DOM (and the SR cursor) alone
    // While the user is INSIDE the bank (tabbing / screen-reader browsing), a live
    // table broadcast must NOT rebuild it — replacing innerHTML resets a screen
    // reader's virtual cursor every couple of seconds ("the store bounces me
    // around"). Defer; the rebuild happens when focus leaves, or immediately after
    // the user's OWN buy/sell (force=true), with focus restored to the same button.
    if (focusedInside && !force) { _bankDirty = true; return; }
    let key = null;
    if (focusedInside) {
      key = a.dataset.buySlot ? 'buy:' + a.dataset.buySlot
          : a.dataset.sellSlot ? 'sell:' + a.dataset.sellSlot
          : a.hasAttribute('data-bank-close') ? 'close' : null;
    }
    el.innerHTML = html;
    _bankDirty = false;
    if (key) {
      const sel = key === 'close' ? '[data-bank-close]'
                : key.startsWith('buy:') ? `[data-buy-slot="${key.slice(4)}"]`
                : `[data-sell-slot="${key.slice(5)}"]`;
      const next = el.querySelector(sel); if (next) { try { next.focus(); } catch (_) {} }
    }
  }
  // When focus leaves the bank, apply any rebuild we deferred while browsing it.
  $('#bankDoll')?.addEventListener('focusout', () => {
    setTimeout(() => {
      const el = $('#bankDoll');
      if (_bankDirty && el && !el.contains(document.activeElement)) renderSidebarBank(true);
    }, 0);
  });
  function renderBank() { /* legacy no-op — gear bank also lives in the action panel */ }

  $('#sidebarBankToggle')?.addEventListener('click', (e) => { e.stopPropagation(); _bankDollOpen ? closeBankDoll() : openBankDoll($('#sidebarBankToggle')); });
  $('#dungeonBankToggle')?.addEventListener('click', (e) => { e.stopPropagation(); _bankDollOpen ? closeBankDoll() : openBankDoll($('#dungeonBankToggle')); });
  $('#bankDoll')?.addEventListener('click', (e) => { if (e.target.closest('[data-bank-close]')) closeBankDoll(); });
  // Keep keyboard focus INSIDE the open bank dialog (Tab wraps), and let Escape
  // close it from anywhere within. So a SR/keyboard user is "contained" in the
  // bank and tabs cleanly through its controls until they Escape back out.
  $('#bankDoll')?.addEventListener('keydown', (e) => {
    if (!_bankDollOpen) return;
    const el = $('#bankDoll'); if (!el) return;
    if (e.key === 'Escape') { e.stopPropagation(); closeBankDoll(); return; }
    if (e.key !== 'Tab') return;
    const f = [...el.querySelectorAll('button:not([disabled]), [href], input, select, [tabindex]:not([tabindex="-1"])')].filter(x => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // Click anywhere outside the doll (and not a toggle / a gear button) closes it.
  document.addEventListener('click', (e) => {
    if (!_bankDollOpen) return;
    if (e.target.closest('#bankDoll') || e.target.closest('#sidebarBankToggle') || e.target.closest('#dungeonBankToggle')) return;
    closeBankDoll();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _bankDollOpen) closeBankDoll(); });

  // ===== LOOT LORD ceremony overlay =====
  function renderLootLord() {
    const overlay = $('#lootlordOverlay');
    if (!overlay) return;
    const ll = state.table?.lootLord;
    if (!ll) { overlay.hidden = true; return; }
    overlay.hidden = false;
    $('#lootlordPortrait').innerHTML = renderAvatar(ll.avatarId);
    $('#lootlordName').textContent = ll.nickname.toUpperCase();
    $('#lootlordStats').textContent = `Crowned after ${ll.handCount} hand${ll.handCount===1?'':'s'} · ${formatChips(ll.finalChips)} gp in the bank`;
    // Initial countdown text; tickTimers updates it every 250ms.
    const remain = Math.max(0, Math.ceil((ll.resetAt - Date.now()) / 1000));
    $('#lootlordCountdown').textContent = remain + 's';
  }

  // ===== Action panel host (permanent — never destroyed) =====
  // Tracks whether it was my turn on the previous render, so we only
  // move focus on the false→true transition (not every state tick).
  let _actpanelPrevCanAct = false;
  function renderActionPanel() {
    const host = $('#actpanelHost');
    const panel = $('#actionPanel');
    if (!host || !panel) return;
    if (!state.me || !state.table) { host.hidden = true; return; }
    const t = state.table;
    const hand = t.hand;
    const mySeat = t.seats?.find(s => s.playerId === state.me.player_id);
    if (!mySeat) { host.hidden = true; return; }
    host.hidden = false;
    // Find me in the hand (if active).
    const meInHand = hand?.players?.find(p => p.playerId === state.me.player_id);
    const isActor = hand && hand.actor === state.me.player_id;
    const canAct = !!(isActor && meInHand && !meInHand.folded && !meInHand.allIn
                     && hand.state !== 'SHOWDOWN' && hand.state !== 'COMPLETE');
    panel.classList.toggle('actpanel--idle', !canAct);
    panel.innerHTML = buildActionPanelInner(hand, meInHand, canAct);
    // Blind support: when it becomes MY turn, move keyboard focus onto
    // the action controls so a screen reader lands on Check/Call (and the
    // player can Tab to Fold/Raise) without hunting. Only on the
    // false→true edge — re-focusing every tick would fight the user.
    // The push-to-talk keydown handler calls preventDefault on the talk
    // key, so holding Space here won't accidentally click this button.
    if (window.BlindMode?.isOn?.() && canAct && !_actpanelPrevCanAct) {
      // Land on Check/Call specifically — NOT the Fold button (which is
      // first in DOM order), so an accidental Enter doesn't fold the hand.
      const primary = panel.querySelector('.actpanel__btn[data-act="check"], .actpanel__btn[data-act="call"]');
      if (primary) { try { primary.focus(); } catch (_) {} }
    }
    _actpanelPrevCanAct = canAct;
  }

  // ===== Chat log (bottom panel) =====
  const KIND_CLASS = { hand: 'hand', win: 'win', rebuy: 'rebuy', leave: 'leave', join: 'leave', debt: 'debt', info: 'info', action: 'action', lootlord: 'lootlord', banter: 'banter', human: 'human', fight: 'fight' };
  const _seenChatIds = new Set();
  function fmtClock(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  // Map of chat-entry id → audio payload, retained so the user can
  // click a banter line later to replay it. Stored in JS (not the
  // DOM) because base64 11labs audio can be 10-30kB per line and
  // shoving that into data attributes balloons the DOM tree.
  const _chatAudioById = new Map();
  function appendChatEntry(entry) {
    if (_seenChatIds.has(entry.id)) return;
    _seenChatIds.add(entry.id);
    const list = $('#chatList');
    if (!list) return;
    const li = document.createElement('li');
    li.className = 'chat-entry chat-entry--' + (KIND_CLASS[entry.kind] || 'info');
    li.dataset.chatId = entry.id;
    // Stash audio so we can replay on click. audioUrl is a static
    // path (Crisp/Elfrip sound pools); audio is base64 11labs MP3.
    if (entry.audioUrl || entry.audio) {
      _chatAudioById.set(entry.id, {
        audioUrl: entry.audioUrl || null,
        audio: entry.audio || null,
        audioMime: entry.audioMime || 'audio/mpeg',
      });
      li.classList.add('chat-entry--has-audio');
      li.title = 'Click to replay';
    }
    li.innerHTML =
      `<span class="chat-entry__time">${fmtClock(entry.ts)}</span>` +
      `<span class="chat-entry__text">${escapeText(entry.text)}</span>`;
    list.appendChild(li);
    // STICKY: while stuck to the bottom, pin to the newest INSTANTLY on every
    // message (no smooth chase, no re-deriving "near bottom" — incidental nudges
    // can't knock it loose). While unstuck (the reader deliberately scrolled up),
    // just flag the jump arrow so they keep their place.
    if (_chatStuck) list.scrollTop = list.scrollHeight;
    else { const jb = $('#chatJump'); if (jb) jb.classList.add('chat-jump--new'); }
    updateChatJump();
  }
  // Snap the chat to the newest message, re-stick, and cancel any idle-return.
  const CHAT_IDLE_RETURN_MS = 20000;   // a scrolled-up reader drifts back to bottom after this
  const CHAT_STICK_PX = 48;            // within this of the bottom counts as "at the bottom" — generous so small nudges don't unstick
  function scrollChatToBottom() {
    const list = $('#chatList');
    if (!list) return;
    clearTimeout(_chatIdleTimer); _chatIdleTimer = null;
    _chatStuck = true;
    list.scrollTop = list.scrollHeight;
    const jb = $('#chatJump');
    if (jb) jb.classList.remove('chat-jump--new');
    updateChatJump();
  }
  // ── Chat "jump to present" arrow ────────────────────────────────────
  // Shown only when unstuck (the reader scrolled up); click re-sticks to newest.
  function updateChatJump() {
    const jb = $('#chatJump');
    if (!jb) return;
    jb.hidden = _chatStuck;
    if (_chatStuck) jb.classList.remove('chat-jump--new');
  }
  (function wireChatJump() {
    const list = $('#chatList');
    const jb = $('#chatJump');
    if (!list || !jb) return;
    jb.addEventListener('click', scrollChatToBottom);
    let raf = 0;
    list.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // Stuck iff at/within a hair of the bottom. A deliberate scroll-up moves
        // well past CHAT_STICK_PX → unstick; landing back at the bottom re-sticks.
        // Our own instant pin lands at the bottom, so it stays stuck.
        const dist = list.scrollHeight - list.scrollTop - list.clientHeight;
        _chatStuck = dist <= CHAT_STICK_PX;
        clearTimeout(_chatIdleTimer); _chatIdleTimer = null;
        if (!_chatStuck) _chatIdleTimer = setTimeout(scrollChatToBottom, CHAT_IDLE_RETURN_MS);
        updateChatJump();
      });
    }, { passive: true });
    updateChatJump();
  })();
  // Click-to-replay: any chat entry with stored audio re-plays on
  // click. Ignores the voice-toggle gate on the assumption that an
  // explicit user click overrides the global preference — they're
  // asking for this specific line, right now.
  const _chatList = $('#chatList');
  if (_chatList) {
    _chatList.addEventListener('click', (e) => {
      const li = e.target.closest('li.chat-entry');
      if (!li) return;
      // Chat ids are unique STRINGS (e.g. "c<tag>-main-5"), not numbers —
      // look them up as-is (a stray Number() here used to NaN-out replay).
      const id = li.dataset.chatId;
      if (!id) return;
      const a = _chatAudioById.get(id);
      if (!a) return;
      if (a.audioUrl) { enqueueVoiceUrl(a.audioUrl); }            // through the SpeechBus — no overlap
      else if (a.audio) { enqueueVoice(a.audio, a.audioMime || 'audio/mpeg'); }
    });
  }
  function renderChatLog(entries) {
    const list = $('#chatList');
    if (!list) return;
    // Only render entries we haven't already seen (e.g. on a state snapshot,
    // many will already be there from earlier events).
    for (const e of entries) appendChatEntry(e);
  }

  // ===== Spectators (top bar, between the clock and the user profile) =====
  // Connected-but-not-seated watchers as a row of small tokens. If the tokens
  // don't fit the slot, fall back to compact comma-joined names. The topbar is
  // a single short row, so tokens carry the name in a tooltip (no label under).
  function renderSpectators(specs) {
    const el = document.getElementById('topSpectators');
    if (!el) return;
    const list = Array.isArray(specs) ? specs : [];
    if (list.length === 0) {
      el.hidden = true;
      el.innerHTML = '';
      el.removeAttribute('title');
      el.classList.remove('topbar__spectators--names');
      return;
    }
    el.hidden = false;
    const names = list.map(s => s.nickname || s.playerId);
    el.title = `Watching (${names.length}): ${names.join(', ')}`;
    // Token + name chips first.
    el.classList.remove('topbar__spectators--names');
    el.innerHTML = list.map(s =>
      `<span class="topbar__spec-chip" title="${escapeAttr(s.nickname || '')}">`
      + `<span class="topbar__spec-token">${renderAvatar(s.avatarId)}</span>`
      + `<span class="topbar__spec-name">${escapeText(s.nickname || s.playerId)}</span>`
      + `</span>`
    ).join('');
    // If the chips overflow the slot, drop to compact comma-joined names.
    if (el.scrollWidth > el.clientWidth + 2) {
      el.classList.add('topbar__spectators--names');
      el.textContent = names.join(', ');
    }
  }

  // ===== SVG 7-segment digit renderer for the big topbar clock =====
  // Segment layout (a = top, then clockwise; g = middle):
  //    aaa
  //   f   b
  //    ggg
  //   e   c
  //    ddd
  const DIGIT_SEGS = {
    0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc',
    5: 'afgcd', 6: 'afgecd', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd',
  };
  // Each segment's drawn rectangle (h = horiz, v = vert). Coords assume
  // a 26 × 46 viewBox per digit (so total clock with colon ≈ 130 × 46).
  const SEG_PATHS = {
    // x, y, w, h
    a: 'M 4 1   L 22 1   L 20 5   L 6 5  Z',
    b: 'M 23 2  L 25 4   L 25 21  L 22 22 L 21 20 L 21 6 Z',
    c: 'M 25 25 L 25 42  L 23 44  L 21 41 L 21 26 L 22 24 Z',
    d: 'M 4 45  L 6 41   L 20 41  L 22 45 Z',
    e: 'M 3 25  L 5 24   L 5 41   L 3 44  L 1 42  L 1 26 Z',
    f: 'M 3 1   L 5 5    L 5 20   L 3 22  L 1 21  L 1 4  Z',
    g: 'M 4 23  L 6 21   L 20 21  L 22 23 L 20 25 L 6 25 Z',
  };
  function digitSvg(n) {
    const on = new Set((DIGIT_SEGS[n] || '').split(''));
    const segs = Object.entries(SEG_PATHS).map(([k, d]) =>
      `<path d="${d}" class="topbar__clock-digit-seg-${on.has(k) ? 'on' : 'off'}" />`
    ).join('');
    return `<svg viewBox="0 0 26 46" width="22" height="38">${segs}</svg>`;
  }
  function colonSvg() {
    return `<svg viewBox="0 0 8 46" width="6" height="38">`
      + `<circle cx="4" cy="17" r="3" class="topbar__clock-digit-seg-on"/>`
      + `<circle cx="4" cy="32" r="3" class="topbar__clock-digit-seg-on"/>`
      + `</svg>`;
  }
  /** Build SVG digits HTML for "M:SS" or "MM:SS". Shared by both
   *  the action timer and the hand-elapsed timer so they look
   *  visually identical (only color differs via container class). */
  function buildClockDigitsHtml(secs) {
    const total = Math.max(0, Math.floor(secs));
    const m = Math.floor(total / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    const mStr = String(m);
    return [...mStr].map(c => digitSvg(Number(c))).join('')
         + colonSvg()
         + [...ss].map(c => digitSvg(Number(c))).join('');
  }
  /** Render the action-timer digits into the main topbar slot. */
  function renderClockDigits(secs) {
    const el = document.getElementById('topClockDigits');
    if (!el) return;
    el.innerHTML = buildClockDigitsHtml(secs);
  }

  // Top-center turn banner for the DUNGEON: whose turn it is + (for a human on
  // the clock) their countdown. Reuses the shared #actionTimerBanner element; it
  // shows ONLY on the dungeon screen during combat, and is hidden everywhere else.
  function updateDungeonTurnBanner() {
    const atb = document.getElementById('actionTimerBanner');
    if (!atb) return;
    const d = state.dungeon;
    if (document.body.dataset.screen !== 'dungeon' || !d || d.status !== 'combat' || !d.turn) { atb.hidden = true; return; }
    const turn = d.turn;
    let who = 'Acting…', secs = null, mode = 'next';
    if (turn.kind === 'party') {
      const m = (d.party || []).find(p => p.playerId === turn.id);
      const isMe = state.me && turn.id === state.me.player_id;
      who = isMe ? 'Your turn' : (m?.nickname || 'Acting…');
      if (m && m.afkAt) {   // a human is on the clock → live countdown
        const rem = Math.max(0, m.afkAt - Date.now());
        secs = Math.ceil(rem / 1000);
        mode = (isMe && rem < 10000) ? 'urgent' : 'action';
      } else {
        mode = 'next';   // an AI party member — quick, no precise deadline
        who = (m?.nickname || 'Ally') + ' acting…';
      }
    } else {
      who = 'Enemies acting…';
      mode = 'next';
    }
    atb.dataset.mode = mode;
    atb.innerHTML = `<span class="at-who">${escapeText(who)}</span>` + (secs != null ? `<span class="at-secs">${secs}s</span>` : '');
    atb.hidden = false;
  }

  // ===== Combined timer tick: seat countdowns AND the big topbar clock =====
  function tickTimers() {
    updateDungeonTurnBanner();   // dungeon top-center turn/timer banner
    // Per-seat countdowns. Bots show "🤔 thinking…" with no urgency
    // pulse — they're not going to time out, they're just deciding.
    // Humans show a precise mm:ss with red pulse under 10s.
    const els = $$('[data-seat-timer]');
    for (const el of els) {
      const deadline = Number(el.dataset.deadline);
      const remaining = Math.max(0, deadline - Date.now());
      const s = Math.ceil(remaining / 1000);
      const isBot = el.dataset.seatTimerBot === '1';
      if (isBot) {
        // Fixed 3-character dot frame so the pill never reflows mid-think.
        // The previous '...' / '..' / '.' rotation grew/shrank the timer
        // box every 350ms, which jostled the surrounding seat layout.
        const cycle = Math.floor(Date.now() / 350) % 3;
        const dots = ['.  ', '.. ', '...'][cycle];
        el.textContent = `🤔 thinking${dots}`;
        el.classList.remove('is-urgent');
      } else {
        const mm = Math.floor(s / 60);
        const ss = String(s % 60).padStart(2, '0');
        el.textContent = `⏱ ${mm}:${ss}`;
        el.classList.toggle('is-urgent', remaining < 10000);
      }
    }
    // Topbar digital clock — three modes:
    //   action: a human is on the clock (state.table.actionDeadline > now)
    //   next:   between hands (state.table.nextHandAt > now)
    //   idle:   waiting / no countdown
    const clock = document.getElementById('topClock');
    const label = document.getElementById('topClockLabel');
    if (!clock || !label) return;
    const t = state.table;
    const now = Date.now();
    const actionMs = t?.actionDeadline ? t.actionDeadline - now : 0;
    const nextMs   = t?.nextHandAt ? t.nextHandAt - now : 0;

    // If a Loot Lord ceremony is running, the topbar clock shows the
    // reset countdown and the overlay's countdown updates here too.
    const llMs = t?.lootLord?.resetAt ? t.lootLord.resetAt - now : 0;
    if (t?.lootLord) {
      const lc = document.getElementById('lootlordCountdown');
      if (lc) lc.textContent = Math.max(0, Math.ceil(llMs/1000)) + 's';
      clock.dataset.mode = 'urgent';
      label.textContent = 'GAME RESETS IN';
      renderClockDigits(Math.max(0, Math.ceil(llMs/1000)));
      return;
    }
    if (actionMs > 0) {
      const secs = Math.ceil(actionMs / 1000);
      // Bots show "thinking", humans show "auto-fold in" with urgency
      // colors only when the auto-fold clock is real (i.e. it's a
      // human who'll actually be folded by the server).
      const actorId = t.hand?.actor;
      const actorSeat = t.seats.find(s => s.playerId === actorId);
      const isBot = !!actorSeat?.isBot;
      const isMe  = actorId && state.me && actorId === state.me.player_id;
      const mode = isBot
        ? 'next'                                        // cyan, no urgency pulse
        : (actionMs < 10000 ? 'urgent' : 'action');     // brass → red pulse
      clock.dataset.mode = mode;
      label.textContent = isMe
        ? `Your turn · auto-fold in`
        : isBot
          ? `${actorSeat?.nickname || 'Bot'} · thinking`
          : `${actorSeat?.nickname || 'Acting'} · auto-fold in`;
      renderClockDigits(secs);
    } else if (nextMs > 0) {
      clock.dataset.mode = 'next';
      label.textContent = 'Next hand in';
      renderClockDigits(Math.ceil(nextMs / 1000));
    } else {
      clock.dataset.mode = 'idle';
      label.textContent = t?.hand ? 'In hand' : 'Waiting for players';
      renderClockDigits(0);
    }

    // ----- Hand-elapsed cell (right of divider) -----
    // Whole cell (label + digits) shows/hides as a unit so the "HAND
    // TIMER" label and the divider both appear only when a hand is
    // live. Same SVG digit renderer as the action timer for visual
    // consistency; CSS colors the hand-timer brass.
    const handEl    = document.getElementById('topClockHand');
    const dividerEl = document.getElementById('topClockDivider');
    const handCell  = document.getElementById('topClockHandCell');
    if (handEl && dividerEl && handCell) {
      if (t?.hand?.startedAt) {
        const elapsedSec = Math.max(0, Math.floor((now - t.hand.startedAt) / 1000));
        handEl.innerHTML = buildClockDigitsHtml(elapsedSec);
        handCell.hidden = false;
        dividerEl.hidden = false;
      } else {
        handCell.hidden = true;
        dividerEl.hidden = true;
      }
    }
  }
  setInterval(tickTimers, 250);

  function stageLabel(stage, seated, watching) {
    const t = state.table;
    const watchPart = watching > 0 ? ` · ${watching} watching` : '';
    if (stage === 'WAITING') {
      // Need ≥2 seated AND ≥2 with chips to actually deal.
      const ready = (t?.seats || []).filter(s => s.occupied && (s.chips || 0) > 0).length;
      if (ready < 2) return `Need ${2 - ready} more player${ready === 1 ? '' : 's'} with chips${watchPart}`;
      return `Dealing in…${watchPart}`;
    }
    if (stage === 'COMPLETE') return 'Hand complete' + watchPart;
    if (stage === 'SHOWDOWN') return 'Showdown' + watchPart;
    return stage + watchPart;
  }

  /** Big centered winner display, shown during the post-hand pause.
   *  One block per pot winner (covers side-pot scenarios). Pulls
   *  avatar from the seat, nickname + amount + hand description from
   *  the winners[] entry. Hidden whenever the hand isn't at
   *  SHOWDOWN / COMPLETE — clears on the next deal. */
  function renderWinnerBanner(hand) {
    const banner = $('#handBanner');
    if (!banner) return;
    if (!hand || (hand.state !== 'COMPLETE' && hand.state !== 'SHOWDOWN')
        || !hand.winners?.length) {
      banner.hidden = true;
      banner.innerHTML = '';
      return;
    }
    const blocks = hand.winners.map(w => {
      const seat = state.table?.seats?.find(s => s.playerId === w.playerId);
      const nick = seat?.nickname || w.playerId;
      const avatar = seat?.avatarId ? renderAvatar(seat.avatarId) : '';
      const desc = w.handDesc || '';
      // The cards that won, low→high. Backend sends 2-5 cards depending
      // on whether the board was out — we just render whatever's there.
      const cardsHtml = (w.winningCards || []).length
        ? `<div class="hand-banner__cards">${
            w.winningCards.map(c => window.FolkenCards.card(c)).join('')
          }</div>`
        : '';
      return `
        <div class="hand-banner__win">
          <div class="hand-banner__avatar">${avatar}</div>
          <div class="hand-banner__text">
            <div class="hand-banner__nick">${escapeText(nick)}</div>
            <div class="hand-banner__amount">+ ${formatGp(w.amount)}</div>
            ${desc ? `<div class="hand-banner__hand">${escapeText(desc)}</div>` : ''}
            ${cardsHtml}
          </div>
        </div>`;
    }).join('');
    banner.innerHTML = `<div class="hand-banner__inner">${blocks}</div>`;
    banner.hidden = false;
  }

  /**
   * Inline action panel HTML, rendered under the player's own seat when
   * it's their turn. Compact layout with Fold / Check|Call / Raise / All-in
   * and a row of preset raise-to amounts that fill the editable input.
   */
  /** Build the INNER markup of the action panel — the outer .actpanel
   *  element is permanent in the DOM (#actionPanel), so we never wrap
   *  with another. `canAct` toggles disabled state on the buttons so the
   *  panel stays visible even when it's not the user's turn. */
  function buildActionPanelInner(hand, me, canAct) {
    // If no live hand / no seat, show a minimal "Waiting" panel. The
    // bank + leaderboard live in the perimeter columns now, so the
    // panel itself is just a status header here.
    if (!hand || !me) {
      return `
        <div class="actpanel__drag" data-actpanel-drag title="Drag to move · click reset to recenter">
          <span class="actpanel__drag-grip">⋮⋮</span>
          <span class="actpanel__status">${hand ? 'Spectating' : 'Waiting for next hand'}</span>
          <button type="button" class="actpanel__drag-reset" data-actpanel-reset title="Reset to default position">reset</button>
        </div>`;
    }
    const toCall = Math.max(0, hand.currentBet - me.invested);
    const minRaiseTo = Math.max(hand.currentBet + hand.minRaise, hand.currentBet + 1);
    const maxRaiseTo = me.invested + me.stack;        // shove
    const potNow = hand.potTotal;

    // Adaptive presets — different sizings for opening vs. facing a bet.
    let presets;
    if (hand.currentBet === 0) {
      // Opening bet — pot-relative
      presets = [
        { label: '½ pot',  value: Math.max(minRaiseTo, Math.round(potNow / 2)) },
        { label: '¾ pot',  value: Math.max(minRaiseTo, Math.round(potNow * 0.75)) },
        { label: 'Pot',    value: Math.max(minRaiseTo, potNow) },
        { label: '2× pot', value: Math.max(minRaiseTo, potNow * 2) },
      ];
    } else if (hand.board.length === 0) {
      // Pre-flop facing a bet (typically the blinds) — BB multiples
      presets = [
        { label: '2.5×', value: Math.round(hand.currentBet * 2.5) },
        { label: '3×',   value: hand.currentBet * 3 },
        { label: '4×',   value: hand.currentBet * 4 },
        { label: 'Pot',  value: Math.max(minRaiseTo, potNow + toCall) },
      ];
    } else {
      // Facing a postflop bet — re-raise sizings
      presets = [
        { label: 'Min',   value: minRaiseTo },
        { label: '½ pot', value: Math.max(minRaiseTo, Math.round((potNow + toCall) / 2 + hand.currentBet)) },
        { label: 'Pot',   value: Math.max(minRaiseTo, potNow + toCall + hand.currentBet) },
        { label: '2× pot',value: Math.max(minRaiseTo, (potNow + toCall) * 2 + hand.currentBet) },
      ];
    }
    // Clamp every preset to legal max (can't raise more than you have).
    presets = presets.map(p => ({ ...p, value: Math.min(p.value, maxRaiseTo) }));
    // Dedupe by value (when several presets squash to the same legal max)
    const seen = new Set();
    presets = presets.filter(p => {
      if (seen.has(p.value)) return false;
      seen.add(p.value); return true;
    });

    const dis = canAct ? '' : 'disabled';
    const callOrCheck = toCall === 0
      ? `<button class="btn btn--primary actpanel__btn" data-act="check" ${dis}>Check</button>`
      : `<button class="btn btn--primary actpanel__btn" data-act="call" ${dis}>Call ${formatGp(Math.min(toCall, me.stack))}</button>`;

    const presetHtml = presets.map(p =>
      `<button type="button" class="actpanel__preset" data-raise="${p.value}" ${dis}>${p.label} · ${formatGp(p.value)}</button>`
    ).join('');

    const status = canAct
      ? `to call ${formatChips(toCall)} · pot ${formatChips(potNow)}`
      : `pot ${formatChips(potNow)} · waiting on opponent`;

    // Bank + leaderboard now live in the perimeter sidebars, so the
    // in-panel toggles are gone — the action panel is purely action
    // buttons + the raise input.

    // ----- Mobile "my hand" strip -----
    // On mobile, seats are tiny (token + name only) so the player's own
    // hole cards + chips live here in the action panel. Hidden on desktop
    // via CSS (.actpanel__myhand display none) but always rendered so
    // toggling viewport doesn't need a re-render.
    const myHoleCards = (state.myHole && state.myHole.length === 2)
      ? state.myHole.map(c => window.FolkenCards.card(c)).join('')
      : `${window.FolkenCards.faceDown()}${window.FolkenCards.faceDown()}`;
    const myHandStrip = `
      <div class="actpanel__myhand">
        <div class="actpanel__myhand-cards">${myHoleCards}</div>
        <div class="actpanel__myhand-info">
          <div class="actpanel__myhand-chips">💰 ${formatGp(me.stack)}</div>
          ${me.invested ? `<div class="actpanel__myhand-bet">bet ${formatGp(me.invested)}</div>` : ''}
        </div>
      </div>`;

    return `
      <div class="actpanel__drag" data-actpanel-drag title="Drag to move · click reset to recenter">
        <span class="actpanel__drag-grip">⋮⋮</span>
        <span class="actpanel__status">${status}</span>
        <button type="button" class="actpanel__drag-reset" data-actpanel-reset title="Reset to default position">reset</button>
      </div>
      ${myHandStrip}
      <div class="actpanel__row">
        <button class="btn btn--ghost actpanel__btn" data-act="fold" ${dis}>Fold</button>
        ${callOrCheck}
        <button class="btn btn--danger actpanel__btn" data-act="allin" ${dis}>All-in</button>
      </div>
      <div class="actpanel__row actpanel__row--raise">
        <input type="number" class="actpanel__amount" data-raise-input
               min="${minRaiseTo}" max="${maxRaiseTo}"
               placeholder="≥ ${formatChips(minRaiseTo)}" ${dis} />
        <button class="btn btn--accent actpanel__btn" data-act="raise" ${dis}>Raise to</button>
      </div>
      <div class="actpanel__presets">${presetHtml}</div>
    `;
  }

  /** Legacy no-op. The actionWait footer was replaced by the chat panel
   *  + the persistent actpanel host; "waiting on X" lives in the
   *  topbar clock label and the actpanel status now. */
  function renderActionBar(_hand) { /* intentionally empty */ }

  function sitDown(seatIndex) {
    socket.emit('table:sit', { seatIndex }, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'Could not sit', true); return; }
      toast(`Seated at #${resp.seatIndex + 1}`);
    });
  }

  // ===== Action panel drag wiring =====
  // The action panel lives in #actpanelHost (sibling of #seatRing) so
  // pointerdown on its drag handle does NOT bubble to seatRing. Listen
  // on the document instead — that catches drags anywhere the user
  // moves their mouse, including off the panel mid-drag.
  let _dragState = null;
  document.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-actpanel-drag]');
    if (!handle) return;
    if (e.target.closest('[data-actpanel-reset]')) return;
    const panel = handle.closest('[data-actpanel]');
    if (!panel) return;
    e.preventDefault();
    const start = readActpanelOffset() || { dx: 0, dy: 0 };
    _dragState = {
      panel,
      startX: e.clientX,
      startY: e.clientY,
      origDx: start.dx,
      origDy: start.dy,
      pointerId: e.pointerId,
    };
    panel.classList.add('is-dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (_) { /* not supported here */ }
  });
  document.addEventListener('pointermove', (e) => {
    if (!_dragState || e.pointerId !== _dragState.pointerId) return;
    const dx = _dragState.origDx + (e.clientX - _dragState.startX);
    const dy = _dragState.origDy + (e.clientY - _dragState.startY);
    state.actpanelOffset = { dx, dy };
    applyActpanelOffset();
    saveActpanelOffset();
  });
  const endDrag = (e) => {
    if (!_dragState) return;
    if (e && e.pointerId !== _dragState.pointerId) return;
    _dragState.panel.classList.remove('is-dragging');
    _dragState = null;
    saveActpanelOffset();
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  // The reset link inside the drag handle (separate from the seat-ring
  // click delegate below).
  document.addEventListener('click', (e) => {
    const reset = e.target.closest('[data-actpanel-reset]');
    if (!reset) return;
    e.stopPropagation();
    state.actpanelOffset = null;
    applyActpanelOffset();
    saveActpanelOffset();
  });

  // ===== Action panel click wiring (delegated; panel is re-rendered each turn) =====
  // Seat-ring clicks (sit-down on empty seat, × to kick a player/bot).
  $('#seatRing').addEventListener('click', (e) => {
    // New unified kick (humans + bots). Also accept the legacy data-remove-bot
    // attribute so any in-flight DOM from a stale render still works.
    const kickBtn = e.target.closest('button[data-kick-player], button[data-remove-bot]');
    if (kickBtn) {
      e.stopPropagation();
      const playerId = kickBtn.dataset.kickPlayer || kickBtn.dataset.removeBot;
      const seat = state.table?.seats?.find(s => s.playerId === playerId);
      const nick = seat?.nickname || playerId;
      socket.emit('table:kickPlayer', { playerId }, (resp) => {
        if (!resp?.ok) { toast(resp?.error || 'Could not kick player', true); return; }
        toast(state.table?.hand ? `${nick} will leave after this hand` : `${nick} left the table`);
      });
      return;
    }
    // Attack buttons — cosmetic combat gag (melee / lightning / stinking cloud).
    const fightBtn = e.target.closest('button[data-fight-player]');
    if (fightBtn) {
      e.stopPropagation();
      const targetPlayerId = fightBtn.dataset.fightPlayer;
      const attack = fightBtn.dataset.attack || 'melee';
      socket.emit('table:fight', { targetPlayerId, attack }, (resp) => {
        if (!resp?.ok) { toast(resp?.error || 'Cannot attack right now', true); return; }
      });
      return;
    }
  });

  // Action panel clicks (now OUTSIDE the seat ring — delegate on document).
  document.addEventListener('click', (e) => {
    // Bank / Leaderboard toggle buttons inside the actpanel.
    const toggle = e.target.closest('[data-toggle-section]');
    if (toggle) {
      e.preventDefault();
      const section = toggle.dataset.toggleSection;
      state.actpanelSection = (state.actpanelSection === section) ? null : section;
      renderActionPanel();
      applyActpanelOffset();
      return;
    }
    // Bank: buy / upgrade
    const buy = e.target.closest('[data-buy-slot]');
    if (buy) {
      e.preventDefault();
      const slot = buy.dataset.buySlot;
      const tier = Number(buy.dataset.buyTier);
      socket.emit('lobby:buyGear', { slot, tier }, (resp) => {
        if (!resp?.ok) { toast(resp?.error || 'Could not buy', true); window.BlindMode?.speak?.(resp?.error || 'Could not buy.', 'urgent'); return; }
        window.BlindMode?.speak?.(`Bought plus ${tier} ${GEAR_META[slot]?.label || slot}.`, 'urgent');
        renderSidebarBank(true);   // user's own action — rebuild now, focus restored to this button
      });
      return;
    }
    // Bank: sell / hock
    const sell = e.target.closest('[data-sell-slot]');
    if (sell) {
      e.preventDefault();
      const slot = sell.dataset.sellSlot;
      socket.emit('lobby:sellGear', { slot }, (resp) => {
        if (!resp?.ok) { toast(resp?.error || 'Could not sell', true); window.BlindMode?.speak?.(resp?.error || 'Could not sell.', 'urgent'); return; }
        toast(`Hocked your ${GEAR_META[slot].label} for ${formatChips(resp.refund)} gp`);
        window.BlindMode?.speak?.(`Hocked your ${GEAR_META[slot].label} for ${formatChips(resp.refund)} gold.`, 'urgent');
        renderSidebarBank(true);   // user's own action — rebuild now, focus restored
      });
      return;
    }
    // Abadar bank: pay down debt (popover button)
    const pay = e.target.closest('[data-pay-debt]');
    if (pay) {
      e.preventDefault();
      const amount = Number(pay.dataset.payDebt);
      if (!Number.isFinite(amount) || amount < 1) return;
      socket.emit('lobby:payDebt', { amount }, (resp) => {
        if (!resp?.ok) { toast(resp?.error || 'Could not pay debt', true); return; }
        if (state.me) {
          state.me.chips = resp.chips;
          state.me.rebuy_debt = resp.rebuyDebt;
        }
        paintMe();
        toast(`Paid ${formatChips(amount)} gp to the First Bank of Abadar`);
      });
      return;
    }
    // Abadar bank: re-buy a fresh stack (moved here from the ≡ options menu).
    if (e.target.closest('[data-rebuy]')) {
      e.preventDefault();
      doRebuy();
      return;
    }
    // Preset chip → fill the raise input
    const preset = e.target.closest('button[data-raise]');
    if (preset) {
      const panel = preset.closest('[data-actpanel]');
      const inp = panel?.querySelector('[data-raise-input]');
      if (inp) {
        inp.value = preset.dataset.raise;
        inp.focus();
      }
      return;
    }
    // Action button (fold/check/call/raise/allin)
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    e.stopPropagation();
    const act = btn.dataset.act;
    const payload = { action: act };
    if (act === 'raise') {
      const panel = btn.closest('[data-actpanel]');
      const inp = panel?.querySelector('[data-raise-input]');
      const v = parseInt(inp?.value, 10);
      if (!Number.isFinite(v)) { toast('Pick a raise amount (use a preset or type one)', true); return; }
      payload.amount = v;
    }
    socket.emit('table:action', payload, (resp) => {
      if (!resp?.ok) toast(resp?.error || 'Action rejected', true);
    });
  });
  // Pressing Enter inside the raise-amount field submits the raise — powers the
  // blind "V = raise custom" prompt (V focuses the box, type the number, press
  // Return) and is handy for any keyboard player.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const inp = e.target?.closest?.('[data-raise-input]'); if (!inp) return;
    e.preventDefault();
    const v = parseInt(inp.value, 10);
    const blind = window.BlindMode?.isOn?.();
    if (!Number.isFinite(v)) { if (blind) window.BlindMode.speak('Enter a number first.', 'urgent'); return; }
    socket.emit('table:action', { action: 'raise', amount: v }, (r) => {
      if (!r?.ok) { toast(r?.error || 'Raise rejected', true); if (blind) window.BlindMode.speak(r?.error || 'Raise rejected.', 'urgent'); }
      else if (blind) window.BlindMode.speak(`Raised to ${v.toLocaleString()}.`, 'urgent');
    });
  });

  // Pronoun dropdown — pushes the selection up to the server so the
  // banter LLM can use the correct pronouns when referring to this
  // player. Server validates against 'he'|'she'|'they'; anything else
  // falls back silently to 'they'.
  (function wireGenderDropdown() {
    const sel = $('#meGender');
    if (!sel) return;
    sel.addEventListener('change', (e) => {
      const v = e.target.value;
      socket.emit('lobby:setGender', { gender: v }, (resp) => {
        if (!resp?.ok) { toast(resp?.error || 'Could not save pronouns', true); return; }
        if (state.me) state.me.gender = resp.gender;
      });
    });
  })();

  // PF1e class + weapon dropdowns — same profile cluster as pronouns. Options
  // come from the server (lobby:pf1meta) so the class roster / staple weapon
  // list stays single-sourced. These pick BAB + weapon dice for the dungeon
  // and the cosmetic bar-brawl; they never touch poker.
  function fillSelect(sel, items, value) {
    if (!sel) return;
    sel.innerHTML = items.map(i => `<option value="${i.key}">${i.label}</option>`).join('');
    if (value != null) sel.value = value;
  }
  // Mirror of the server's weaponProficient() so the dropdown can sort/colour
  // without a round-trip. `w` is a {key, prof} from pf1meta.
  function isProficient(classKey, w) {
    if (!w) return true;
    if (w.key === 'unarmed') return true;
    const p = (state.pf1meta?.proficiency || {})[classKey] || { cats: ['simple', 'martial'] };
    if (w.prof && (p.cats || []).includes(w.prof)) return true;
    if ((p.weapons || []).includes(w.key)) return true;
    return false;
  }
  // Build the weapon <select> for a class: proficient weapons grouped at the
  // top, non-proficient ones below in burnt orange with the −4 penalty spelled
  // out (inline colour for reliable rendering inside native option lists).
  function buildWeaponSelect(wsel, cls, value) {
    const meta = state.pf1meta;
    if (!wsel || !meta) return;
    const pen = meta.profPenalty || -4;
    const prof = [], non = [];
    for (const w of meta.weapons) (isProficient(cls, w) ? prof : non).push(w);
    // Damage type now matters vs DR (skeletons shrug off blades, zombies shrug
    // off everything but slashing…) — spell it out next to the dice.
    const TYPE_NAME = { S: 'slashing', P: 'piercing', B: 'bludgeoning', 'P/S': 'pierce/slash' };
    const opt = (w, bad) =>
      `<option value="${w.key}"${bad ? ' class="weapon-nonprof" style="color:#cc5500"' : ''}>`
      + `${w.name} (${w.dmg}${TYPE_NAME[w.type] ? ' ' + TYPE_NAME[w.type] : ''})${bad ? ` — ${pen} non-prof` : ''}</option>`;
    let html = '';
    if (prof.length) html += `<optgroup label="✔ Proficient">${prof.map(w => opt(w, false)).join('')}</optgroup>`;
    if (non.length)  html += `<optgroup label="✘ Not proficient (${pen} to hit)">${non.map(w => opt(w, true)).join('')}</optgroup>`;
    wsel.innerHTML = html;
    if (value != null) wsel.value = value;
    // Tint the closed select burnt-orange when the chosen weapon is one this
    // class isn't proficient with, so the penalty is visible without opening it.
    const selected = meta.weapons.find(w => w.key === wsel.value);
    wsel.classList.toggle('is-nonprof', !!selected && !isProficient(cls, selected));
  }
  // Per-class level from that class's XP, using the thresholds shipped in pf1meta.
  function classLevelFromXp(xp) {
    const tbl = state.pf1meta && state.pf1meta.xpToLevel; if (!tbl) return 1;
    xp = Math.max(0, Number(xp) || 0); let lvl = 1;
    for (let L = 2; L <= 20; L++) { if (tbl[L] != null && xp >= tbl[L]) lvl = L; else break; }
    return lvl;
  }
  function syncClassWeapon(p) {
    const meta = state.pf1meta;
    if (!meta || !p) return;
    let cxp = {}; try { cxp = JSON.parse(p.class_xp || '{}') || {}; } catch (_) {}
    const cur = p.class || 'fighter';
    // Label each class with the player's LEVEL in that class (XP is per-class). The
    // closed select shows the current class's level too. Current class shows Lv 1
    // even before earning any XP; others only if the player has played them.
    fillSelect($('#meClass'), meta.classes.map(c => {
      const lvl = (cxp[c.key] != null) ? classLevelFromXp(cxp[c.key]) : (c.key === cur ? 1 : null);
      return { key: c.key, label: c.name + (lvl != null ? ` · Lv ${lvl}` : '') };
    }), cur);
    buildWeaponSelect($('#meWeapon'), cur, p.weapon || 'dagger');
  }
  (function wireClassWeaponDropdowns() {
    const csel = $('#meClass'), wsel = $('#meWeapon');
    socket.emit('lobby:pf1meta', null, (resp) => {
      if (!resp?.ok) return;
      state.pf1meta = resp;
      if (state.me) syncClassWeapon(state.me);
    });
    csel?.addEventListener('change', (e) => {
      socket.emit('lobby:setClass', { cls: e.target.value }, (resp) => {
        if (!resp?.ok) { toast(resp?.error || 'Could not save class', true); return; }
        if (state.me) state.me.class = resp.cls;
        // Re-sort/re-colour the weapon list for the new class' proficiencies.
        if (state.me) buildWeaponSelect($('#meWeapon'), resp.cls, state.me.weapon || 'dagger');
        // Blind hint: confirm the switch + your level in that class (XP is per-class,
        // so a class you've never played starts at level 1 — gear & gold carry over).
        if (window.BlindMode?.isOn?.()) {
          let cxp = {}; try { cxp = JSON.parse(state.me?.class_xp || '{}') || {}; } catch (_) {}
          const lvl = (cxp[resp.cls] != null) ? classLevelFromXp(cxp[resp.cls]) : 1;
          const name = state.pf1meta?.classes?.find(c => c.key === resp.cls)?.name || resp.cls;
          window.BlindMode.speak(`You are now a level ${lvl} ${name}.`, 'urgent');
        }
      });
    });
    wsel?.addEventListener('change', (e) => {
      socket.emit('lobby:setWeapon', { weapon: e.target.value }, (resp) => {
        if (!resp?.ok) { toast(resp?.error || 'Could not save weapon', true); return; }
        if (state.me) state.me.weapon = resp.weapon;
        const w = state.pf1meta?.weapons?.find(x => x.key === resp.weapon);
        e.target.classList.toggle('is-nonprof', !!w && !isProficient(state.me?.class || 'fighter', w));
      });
    });
    // Reset the CURRENT class back to Level 1 (0 XP). Destructive but bounded —
    // keeps gear, gold, and every OTHER class's progress (XP is per-class). Guarded
    // by a confirm; takes effect on the next dungeon run, not a fight in progress.
    const rbtn = $('#meResetLevel');
    rbtn?.addEventListener('click', async () => {
      const clsName = state.pf1meta?.classes?.find(c => c.key === (state.me?.class || 'fighter'))?.name || 'this class';
      const ok = await confirmDialog({
        title: `Reset your ${clsName} to Level 1?`,
        body: `This wipes your ${clsName} XP only — your gear, gold, and any other classes you've leveled are kept.`,
        confirmLabel: 'Reset to Level 1', cancelLabel: 'Never mind', danger: true,
      });
      if (!ok) return;
      socket.emit('lobby:resetLevel', null, (resp) => {
        if (!resp?.ok) { toast(resp?.error || 'Could not reset level', true); return; }
        if (state.me) state.me.class_xp = resp.class_xp;
        if (state.me) syncClassWeapon(state.me);   // re-label the class dropdown (now · Lv 1)
        const name = state.pf1meta?.classes?.find(c => c.key === resp.cls)?.name || resp.cls;
        toast(`Your ${name} is back to Level 1.`);
        if (window.BlindMode?.isOn?.()) window.BlindMode.speak(`Your ${name} has been reset to level 1.`, 'urgent');
      });
    });
  })();

  // ===== Topbar — Abadar purse popover tap-to-toggle =====
  // Hover handles desktop via CSS. For touch users (no :hover), tap
  // the chips badge to toggle .is-open on the wrapper; a click anywhere
  // outside closes it. Keyboard users can also Tab onto it (it has
  // tabindex=0) and CSS :focus-within will reveal the popover.
  (function wirePursePopover() {
    const purse = $('#mePurse');
    if (!purse) return;
    purse.addEventListener('click', (e) => {
      // Don't toggle when the click is on a button inside the popover.
      if (e.target.closest('[data-pay-debt]')) return;
      purse.classList.toggle('is-open');
    });
    document.addEventListener('click', (e) => {
      if (purse.contains(e.target)) return;
      purse.classList.remove('is-open');
    });
  })();

  // ===== Global Escape — collapse the topmost open dropdown / popover / modal,
  //       for keyboard AND screen-reader users (one layer per press). This is the
  //       catch-all so EVERY overlay closes on Esc — including the modals/popovers
  //       that previously only closed via a click (Help, Reset, Pick-AI, purse) and
  //       the audio menu (which only closed on Esc when focus was inside it). =====
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 1) Modal dialogs (Help, Reset, Pick-AI).
    const modal = document.querySelector('.modal:not([hidden])');
    if (modal) {
      if (modal.id === 'botPickerModal' && typeof closeBotPicker === 'function') closeBotPicker();
      else modal.hidden = true;
      return;
    }
    // 2) Loot Bank dialog (returns focus to its toggle).
    if (_bankDollOpen) { closeBankDoll(); return; }
    // 3) Money / Bank-of-Abadar purse popover.
    const purseEl = $('#mePurse');
    if (purseEl && purseEl.classList.contains('is-open')) { purseEl.classList.remove('is-open'); return; }
    // 4) Dungeon spellbook / recruit dropdowns (module state → re-render to reflect).
    if (_spellbookOpen) { _spellbookOpen = false; if (document.body.dataset.screen === 'dungeon') renderDungeon(); return; }
    if (_recruitOpen) {
      _recruitOpen = false;
      const pop = $('#dungeonRecruit')?.querySelector('.dungeon__recruit-pop'); if (pop) pop.classList.remove('is-open');
      const tog = $('#dungeonRecruit')?.querySelector('[data-recruit-toggle]'); if (tog) tog.setAttribute('aria-expanded', 'false');
      return;
    }
    // 5) Audio settings menu (close regardless of where focus is).
    const am = $('#audioMenu');
    if (am && am.classList.contains('is-open')) { am.classList.remove('is-open'); const b = $('#muteBtn'); if (b) b.setAttribute('aria-expanded', 'false'); return; }
    // 6) Topbar overflow (hamburger) menu.
    const tm = $('#topbarMenu');
    if (tm && tm.classList.contains('is-open')) { tm.classList.remove('is-open'); const t = $('#topbarMenuToggle'); if (t) t.setAttribute('aria-expanded', 'false'); return; }
  });

  // ===== Topbar =====
  // Re-buy a fresh stack — invoked from the 💰 money-menu button (see the
  // [data-rebuy] delegate above). A function declaration so that earlier-bound
  // delegate is free to call it regardless of source order.
  function doRebuy() {
    const debtNow = Number(state.me?.rebuy_debt || 0);
    const newDebt = debtNow + state.defaultStack;
    const msg = `Loan ${state.defaultStack.toLocaleString()} gp from Abadar?\n\n`
              + `You keep your gear — this is a LOAN added to your stack. Your `
              + `long-term debt goes from ${debtNow.toLocaleString()} → ${newDebt.toLocaleString()} gp.\n`
              + `Pay it down later with winnings.`;
    if (!confirm(msg)) return;
    socket.emit('lobby:resetStack', null, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'Could not borrow', true); return; }
      state.me.chips = resp.chips;
      state.me.rebuy_debt = resp.rebuyDebt;
      paintMe();
      toast(`Borrowed ${state.defaultStack.toLocaleString()} gp — stack now ${resp.chips.toLocaleString()} gp. Debt: ${resp.rebuyDebt.toLocaleString()} gp`);
    });
  }

  // (Pay-Debt button removed — debt tracking is no longer a thing.
  // Old client tabs that still have the button just won't see anything
  // happen because the button no longer exists in the rendered DOM.)
  // ===== Human chat input (trash talk) =====
  // Submit on Enter or Send-button click. Echo is via the normal
  // table:chat broadcast — we don't optimistically render locally,
  // so what you see is what the server actually relayed.
  const chatForm = $('#chatForm');
  if (chatForm) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#chatInput');
      if (!input || !state.me) return;
      const text = input.value.trim();
      if (!text) return;
      socket.emit('table:say', { text }, (resp) => {
        if (resp?.ok) input.value = '';
        else toast(resp?.error || 'Could not send chat', true);
      });
    });
  }

  $('#switchBtn').addEventListener('click', () => {
    socket.emit('table:stand', null, () => {});
    try { sessionStorage.removeItem(PLAYER_KEY); } catch (_) {}
    state.me = null;
    state.pendingPlayerId = null;
    state.myHole = null;
    setScreen('roster');
    renderRoster();
  });
  $('#leaveBtn').addEventListener('click', () => {
    socket.emit('table:stand', null, () => toast('Left the table'));
  });

  // Sit out / Rejoin — toggles based on current seat state. Label and
  // tooltip update in paintMe() so the button always reflects reality.
  $('#sitOutBtn').addEventListener('click', () => {
    const mySeat = state.table?.seats?.find(s => s.playerId === state.me?.player_id);
    if (!mySeat) { toast('Not at a table.', true); return; }
    if (mySeat.sittingOut) {
      socket.emit('table:rejoin', null, (resp) => {
        if (resp?.ok) toast('Back in for the next deal.');
        else toast(resp?.error || 'Could not rejoin', true);
      });
    } else {
      socket.emit('table:sitOut', null, (resp) => {
        if (resp?.ok) toast(state.table?.hand ? 'You\'ll sit out starting next hand.' : 'Sitting out.');
        else toast(resp?.error || 'Could not sit out', true);
      });
    }
  });

  // + Bot opens a picker modal. The user can pick a specific AI or
  // hit Random. table:addBot accepts either an explicit playerId or
  // null (server-side random).
  //
  // The bot list is kept in a module-scoped variable so the search input
  // can re-filter without re-fetching from state.roster. Sort is
  // alphabetical by nickname for ease of finding a known character.
  let _botPickerData = []; // Array<{p, w}>, alphabetized

  function renderBotPickerGrid(query = '') {
    const grid = $('#botPickerGrid');
    const count = $('#botPickerCount');
    if (!grid) return;
    const q = query.trim().toLowerCase();
    const matches = q
      ? _botPickerData.filter(({ p }) => (p.nickname || '').toLowerCase().includes(q))
      : _botPickerData;
    if (matches.length === 0) {
      grid.innerHTML = `<div class="bot-picker__empty">No AI characters match "${escapeText(query)}".</div>`;
    } else {
      grid.innerHTML = matches.map(({ p, w }) => `
        <button type="button" class="bot-picker__card" data-bot-id="${escapeAttr(p.player_id)}" title="${escapeAttr(p.nickname)} · ${formatChips(w)} gp current wealth">
          <div class="bot-picker__avatar">${renderAvatar(p.avatar_id)}</div>
          <div class="bot-picker__nick">${escapeText(p.nickname)}</div>
          <div class="bot-picker__worth">💰 ${formatChips(w)} gp</div>
        </button>
      `).join('');
    }
    if (count) {
      count.textContent = q
        ? `${matches.length} of ${_botPickerData.length}`
        : `${_botPickerData.length} available`;
    }
  }

  function openBotPicker() {
    const modal = $('#botPickerModal');
    const grid  = $('#botPickerGrid');
    if (!modal || !grid) return;
    const seatedIds = new Set((state.table?.seats || []).filter(s => s.playerId).map(s => s.playerId));
    const allBots = (state.roster || []).filter(p => p.is_bot);
    _botPickerData = allBots
      .filter(p => !seatedIds.has(p.player_id))
      .map(p => ({ p, w: rosterWealth(p) }))
      // Alphabetize by nickname (case-insensitive, locale-aware for accented chars).
      .sort((a, b) => (a.p.nickname || '').localeCompare(b.p.nickname || '', undefined, { sensitivity: 'base' }));
    if (_botPickerData.length === 0) {
      toast(`All ${allBots.length} AI characters are already seated.`, true);
      return;
    }
    // Reset search input on each open so the picker is always pristine.
    const searchInput = $('#botPickerSearch');
    if (searchInput) searchInput.value = '';
    renderBotPickerGrid('');
    modal.hidden = false;
    // Focus the search input so the user can immediately start typing.
    if (searchInput) setTimeout(() => searchInput.focus(), 50);
  }
  function closeBotPicker() {
    const m = $('#botPickerModal');
    if (m) m.hidden = true;
  }
  // Seat one AI. When `keepOpen` is true (picker card / Random), the modal
  // stays open and the just-seated character is dropped from the grid — same
  // feel as the dungeon's "Recruit AI" panel, so you can click several in a
  // row. When false (or the table just filled), the picker closes.
  function emitAddBot(playerId, keepOpen = false) {
    socket.emit('table:addBot', playerId ? { playerId } : null, (resp) => {
      if (!resp?.ok) {
        toast(resp?.error || 'Could not add bot', true);
        // A "table full" failure means there's nothing left to do here.
        if (/full|no empty|no available|no seat/i.test(resp?.error || '')) closeBotPicker();
        return;
      }
      const seated = state.roster?.find(p => p.player_id === resp.playerId);
      toast(`${seated?.nickname || 'Bot'} joined the table`);
      if (!keepOpen) { closeBotPicker(); return; }
      // Drop the seated character and re-render; close once the bench is empty.
      _botPickerData = _botPickerData.filter(({ p }) => p.player_id !== resp.playerId);
      if (_botPickerData.length === 0) { closeBotPicker(); return; }
      renderBotPickerGrid($('#botPickerSearch')?.value || '');
    });
  }
  // Fill every empty seat with random AI in one request.
  function emitFillBots() {
    socket.emit('table:fillBots', null, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'Could not fill seats', true); return; }
      toast(`Filled ${resp.seated} seat${resp.seated === 1 ? '' : 's'} with AI`);
    });
    closeBotPicker();
  }
  // "+ Bot" = random AI (fast path), "Pick AI ▾" opens the modal picker.
  $('#addBotBtn').addEventListener('click', () => emitAddBot(null));
  // ↻ Last party — re-seat the AI lineup this browser's human last played with
  // (stored in localStorage by the table:state handler; seating bots is free).
  $('#botPickerLast')?.addEventListener('click', () => {
    let ids = []; try { ids = JSON.parse(localStorage.getItem('fp_lastPokerParty') || '[]'); } catch (_) {}
    if (!ids.length) { toast('No remembered table party yet — play a hand with AI seated first.', true); return; }
    const add = (i, ok) => {
      if (i >= ids.length) { toast(ok ? `↻ Seated ${ok} of ${ids.length} from your last table.` : 'Could not seat your last party (table full or already seated).', !ok); return; }
      socket.emit('table:addBot', { playerId: ids[i] }, (resp) => add(i + 1, ok + (resp && resp.ok !== false ? 1 : 0)));
    };
    add(0, 0);
  });
  $('#pickBotBtn').addEventListener('click', openBotPicker);
  $('#botPickerModal').addEventListener('click', (e) => {
    if (e.target.closest('[data-close-bot-picker]')) { closeBotPicker(); return; }
    if (e.target.closest('#botPickerFill')) { emitFillBots(); return; }   // fills all → closes
    if (e.target.closest('#botPickerRandom')) { emitAddBot(null, true); return; }   // stays open
    const card = e.target.closest('[data-bot-id]');
    if (card) emitAddBot(card.dataset.botId, true);   // stays open — click several
  });
  // Live search-filter for the bot picker grid. `input` fires on every
  // keystroke (including paste / clear), so the grid stays in sync.
  // Enter on the search input picks the first match (quick keyboard flow).
  $('#botPickerSearch')?.addEventListener('input', (e) => {
    renderBotPickerGrid(e.target.value || '');
  });
  $('#botPickerSearch')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('#botPickerGrid [data-bot-id]');
      if (first) {
        e.preventDefault();
        emitAddBot(first.dataset.botId, true);   // seat + keep picker open
      }
    } else if (e.key === 'Escape') {
      // Let Escape close the modal even when focus is in the search box.
      closeBotPicker();
    }
  });
  // (Per-bot × buttons handle removal — wired in the seatRing delegate above.)

  // (Bank buy/sell handlers now live in the document-level click delegate
  // above — bank UI is inline inside the actpanel.)

  // ---- Reset modal ----
  const resetModal = $('#resetModal');
  function openResetModal() { resetModal.hidden = false; }
  function closeResetModal() { resetModal.hidden = true; }

  $('#resetGameBtn').addEventListener('click', openResetModal);
  $('#resetCancelBtn').addEventListener('click', closeResetModal);
  resetModal.querySelector('.modal__backdrop').addEventListener('click', closeResetModal);
  resetModal.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-reset]');
    if (!btn) return;
    const choice = btn.dataset.reset;
    closeResetModal();
    if (choice === 'cancelHand') {
      socket.emit('lobby:cancelHand', null, (resp) => {
        if (resp?.ok) toast('Hand cancelled. New hand starting…');
        else toast(resp?.error || 'Cancel failed', true);
      });
    } else if (choice === 'resetGame') {
      socket.emit('lobby:resetGame', null, (resp) => {
        if (resp?.ok) toast('Game reset — everyone back to ' + formatGp(state.defaultStack));
        else toast(resp?.error || 'Reset failed', true);
      });
    }
  });

  // ===== Helpers =====
  function escapeText(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])); }
  function escapeAttr(s) { return String(s ?? '').replace(/["&<>]/g, c => ({ '"':'&quot;','&':'&amp;','<':'&lt;','>':'&gt;' }[c])); }
  function formatChips(n) { return Number(n || 0).toLocaleString(); }
  /** Same number, with "gp" suffix — for places where the currency
   *  shouldn't be implicit (pot, chat lines, dialogs). */
  function formatGp(n)    { return formatChips(n) + ' gp'; }
  /** Render an avatar: URL → <img>, short key → inline SVG from FolkenAvatars. */
  function renderAvatar(id) {
    if (!id) return '';
    if (id.startsWith('/') || id.startsWith('http')) {
      return `<img class="avatar-img" src="${escapeAttr(id)}" alt="" loading="lazy" />`;
    }
    return window.FolkenAvatars[id] || '';
  }

  // ===== Boot =====
  socket.on('connect', () => {
    const savedId = (() => { try { return sessionStorage.getItem(PLAYER_KEY); } catch (_) { return null; } })();
    if (savedId) {
      socket.emit('lobby:choosePlayer', { playerId: savedId }, (resp) => {
        if (resp?.ok) { state.me = resp.player; enterTable(); }
        else { try { sessionStorage.removeItem(PLAYER_KEY); } catch (_) {}; setScreen('roster'); renderRoster(); }
      });
    } else { setScreen('roster'); renderRoster(); }
  });

  // ===== Blind-mode accessibility wiring =====
  // Backtick toggles the mode. Space (held) is push-to-talk while the
  // mode is on — non-blind tabs never trigger speech recognition.
  // Both shortcuts ignore presses originating from typeable elements
  // so the existing chat box / raise input still work normally.
  (function wireBlindMode() {
    if (!window.BlindMode?.init) return;
    // sit() lets blind mode seat the player by voice ("sit" / "sit seat 3").
    window.BlindMode.init({ state, socket, toast, $, sit: (idx) => sitDown(idx), enterDungeon: () => enterDungeon() });
    const isTypingTarget = (el) => {
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      return el.isContentEditable === true;
    };
    const pttCode = () => window.BlindMode.getPttCode?.() || 'Space';
    document.addEventListener('keydown', (e) => {
      // PTT rebind capture takes priority: the very next key (other than
      // a modifier) becomes the new push-to-talk binding. Runs even over
      // typing targets so the user can pick any key. Escape cancels.
      if (window.BlindMode.isRebinding?.()) {
        if (window.BlindMode.consumeRebind(e.code)) { e.preventDefault(); return; }
      }
      if (e.repeat) return;
      if (e.code === 'Backquote' && !isTypingTarget(e.target)) {
        e.preventDefault();
        window.BlindMode.toggle();
        return;
      }
      // F (fold) / K (checK / call) work as plain poker HOTKEYS even with blind
      // mode OFF — only on YOUR turn, on the table, and never while typing. When
      // blind mode is ON the speaking block below handles F/K instead (no double-fire).
      if (!window.BlindMode.isOn() && !isTypingTarget(e.target)
          && document.body.dataset.screen !== 'dungeon'
          && (e.code === 'KeyF' || e.code === 'KeyK')) {
        const h = state.table?.hand;
        const meId = state.me?.player_id;
        const meP = h?.players?.find(p => p.playerId === meId);
        if (h && h.actor === meId && meP && !meP.folded && !meP.allIn) {
          e.preventDefault();
          const toCall = Math.max(0, (h.currentBet || 0) - (meP.invested || 0));
          const action = e.code === 'KeyF' ? 'fold' : (toCall === 0 ? 'check' : 'call');
          socket.emit('table:action', { action }, (r) => { if (!r?.ok) { try { toast(r?.error || 'Action rejected.', true); } catch (_) {} } });
          return;
        }
      }
      if (!window.BlindMode.isOn() || isTypingTarget(e.target)) return;
      // Push-to-talk (configurable key; default Space). Checked before H
      // so a player who rebinds PTT to H still gets the mic, not a re-read.
      if (e.code === pttCode()) {
        e.preventDefault();
        const chip = $('#blindModeChip');
        if (chip) chip.classList.add('is-listening');
        window.BlindMode.startListening();
        return;
      }
      // H — re-read my hand (hole cards + board). POKER TABLE ONLY: in the dungeon H
      // is party-health (handled in the dungeon key set), so the two stay separate.
      if (e.code === 'KeyH' && document.body.dataset.screen !== 'dungeon') {
        e.preventDefault();
        window.BlindMode.readHand?.();
        return;
      }
      // [ / ] — adjust the reading speed live (persisted). Gives a blind
      // player a way to slow the voice down WITHOUT needing speech
      // recognition (which may be unavailable in their browser).
      if (e.code === 'BracketLeft')  { e.preventDefault(); window.BlindMode.nudgeRate?.(-0.1); return; }
      if (e.code === 'BracketRight') { e.preventDefault(); window.BlindMode.nudgeRate?.(+0.1); return; }
      // - / = (and numpad -/+) adjust the SCREEN-READER VOLUME live (Josh) — same idea
      // as [ / ] for speed, so he can balance the narration against Discord / game audio.
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') { e.preventDefault(); window.BlindMode.nudgeVolume?.(-0.1); return; }
      if (e.code === 'Equal' || e.code === 'NumpadAdd')      { e.preventDefault(); window.BlindMode.nudgeVolume?.(+0.1); return; }
      // S — stop talking now (works on every screen).
      if (e.code === 'KeyS') { e.preventDefault(); window.BlindMode.stopSpeaking?.(); return; }
      // ----- Explore hotkeys (poker table only) -----
      // C / B / P read your cards / the board / the pot. Number keys 1–9 read a
      // seat: the occupant's name, or (if empty) arm it and say "Sit N" so
      // Return takes the seat. Skipped on the dungeon screen, which has its own
      // command set.
      if (document.body.dataset.screen !== 'dungeon') {
        if ((e.code === 'Enter' || e.code === 'NumpadEnter') && window.BlindMode.confirmPendingSit?.()) {
          e.preventDefault();
          return;
        }
        // ? — toggle help/learn mode: keys are spoken, not fired.
        if (e.key === '?') { e.preventDefault(); _blindHelp = !_blindHelp; window.BlindMode.speak(`Help mode ${_blindHelp ? 'on' : 'off'}.`, 'urgent'); return; }
        // Betting actions are on LETTER keys so the NUMBER keys (1–9) stay reserved
        // for the seat reader / "sit in seat N" — those must work even on your turn,
        // when a blind player most needs to re-read the table before acting. Bets
        // only fire on your turn:
        //   F Fold · K checK/Call · R Raise (min) · T raise to poT · A All-in ·
        //   V raise to a custom Value (focuses the raise box).
        const _h = state.table?.hand;
        const _meId = state.me?.player_id;
        const _meP = _h?.players?.find(p => p.playerId === _meId);
        const _myTurn = !!(_h && _h.actor === _meId && _meP && !_meP.folded && !_meP.allIn);
        const _bSay = (t) => window.BlindMode.speak(t, 'urgent');
        const _bSend = (action, amount) => socket.emit('table:action', amount != null ? { action, amount } : { action }, (r) => { if (!r?.ok) _bSay(r?.error || 'Action rejected.'); });
        // ── R RAISE MENU (Josh) ── while open, 1-4 pick a standardized bet:
        // 1 minimum, 2 half pot, 3 pot, 4 all-in. Escape closes; any other key
        // closes it and does its normal job. Dies if the turn moved on.
        if (_raiseMenu) {
          if (!_myTurn) { _raiseMenu = null; }
          else if (e.key === 'Escape') { e.preventDefault(); _raiseMenu = null; _bSay('Raise menu closed.'); return; }
          else {
            const rm = e.code.match(/^(?:Digit|Numpad)([1-4])$/);
            if (rm) {
              e.preventDefault();
              const q = _raiseMenu; _raiseMenu = null;
              const to = [q.minTo, q.halfTo, q.potTo, q.cap][+rm[1] - 1];
              if (to >= q.cap) { _bSay(`All in, ${q.cap.toLocaleString()}.`); _bSend('allin'); }
              else { _bSay(`Raise to ${to.toLocaleString()}.`); _bSend('raise', to); }
              return;
            }
            _raiseMenu = null;
          }
        }
        // ── 0 CARD READER (Josh) ── numbers read SINGLE cards while it's on:
        // 1, 2 your pocket cards; 4, 5, 6 the flop; 7 the turn; 8 the river.
        // 0 or Escape exits; seats read normally again afterwards.
        if (e.code === 'Digit0' || e.code === 'Numpad0') {
          e.preventDefault();
          if (_blindHelp) return _bSay('Zero: toggle card reader — numbers read single cards, one at a time.');
          _cardReader = !_cardReader;
          _bSay(_cardReader
            ? 'Card reader on. 1 and 2 your pocket cards. 4, 5, 6 the flop. 7 the turn. 8 the river. Press 0 to exit.'
            : 'Card reader off. Numbers read seats again.');
          return;
        }
        if (_cardReader) {
          if (e.key === 'Escape') { e.preventDefault(); _cardReader = false; _bSay('Card reader off.'); return; }
          const ck = e.code.match(/^(?:Digit|Numpad)([1-9])$/);
          if (ck) {
            e.preventDefault();
            // HELP mode teaches what each number reads; ACTIVE mode just speaks the
            // card itself (Josh: you know which key you pressed, so no slot label).
            if (_blindHelp) {
              const SLOT_HELP = { 1: 'your first pocket card', 2: 'your second pocket card', 4: 'first flop card', 5: 'second flop card', 6: 'third flop card', 7: 'the turn', 8: 'the river' };
              _bSay(SLOT_HELP[+ck[1]] ? `${ck[1]}: ${SLOT_HELP[+ck[1]]}.` : `${ck[1]}: no card on that key.`);
              return;
            }
            window.BlindMode.readCardSlot?.(+ck[1]);
            return;
          }
        }
        const BET_KEYS = ['KeyF', 'KeyK', 'KeyR', 'KeyT', 'KeyA', 'KeyV'];
        // HELP MODE describes the bet keys even when it's NOT your turn (Josh:
        // F/K/R reported nothing in help because the act-block below is turn-gated).
        // Static descriptions — no live hand math, so they're safe off-turn.
        if (_blindHelp && BET_KEYS.includes(e.code)) {
          e.preventDefault();
          const H = {
            KeyF: 'F: Fold.', KeyK: 'K: Check, or call the current bet.', KeyA: 'A: All in.',
            KeyR: 'R: open the raise menu — then 1 minimum, 2 half pot, 3 pot, 4 all in.',
            KeyT: 'T: Raise to the pot.', KeyV: 'V: Raise a custom amount.',
          };
          window.BlindMode.speak(H[e.code], 'urgent');
          return;
        }
        if (_myTurn && BET_KEYS.includes(e.code)) {
          e.preventDefault();
          const cur = _h.currentBet || 0, inv = _meP.invested || 0, stack = _meP.stack || 0, pot = _h.potTotal || 0;
          const toCall = Math.max(0, cur - inv);
          const minTo = Math.max(cur + (_h.minRaise || 1), cur + 1);
          const potTo = Math.max(minTo, cur === 0 ? pot : pot + toCall + cur);
          const cap = inv + stack;   // a raise to the cap = all-in
          const say = (t) => window.BlindMode.speak(t, 'urgent');
          const send = (action, amount) => socket.emit('table:action', amount != null ? { action, amount } : { action }, (r) => { if (!r?.ok) say(r?.error || 'Action rejected.'); });
          if (e.code === 'KeyF') { if (_blindHelp) return say('F: Fold.'); say('Fold.'); send('fold'); return; }
          if (e.code === 'KeyK') { const lbl = toCall === 0 ? 'Check' : `Call ${Math.min(toCall, stack).toLocaleString()}`; if (_blindHelp) return say(`K: ${lbl}.`); say(`${lbl}.`); send(toCall === 0 ? 'check' : 'call'); return; }
          if (e.code === 'KeyA') { if (_blindHelp) return say(`A: All in, ${cap.toLocaleString()}.`); say(`All in, ${cap.toLocaleString()}.`); send('allin'); return; }
          if (e.code === 'KeyR') {
            // R opens the RAISE MENU (Josh's design): standardized bets on 1-4.
            if (_blindHelp) return say('R: open the raise menu — then 1 minimum, 2 half pot, 3 pot, 4 all in.');
            const halfTo = Math.min(Math.max(minTo, cur === 0 ? Math.max(1, Math.floor(pot / 2)) : cur + Math.floor((pot + toCall) / 2)), cap);
            const q = { minTo: Math.min(minTo, cap), halfTo, potTo: Math.min(potTo, cap), cap };
            _raiseMenu = q;
            say(`Raise menu: 1, minimum, ${q.minTo.toLocaleString()}. 2, half pot, ${q.halfTo.toLocaleString()}. 3, pot, ${q.potTo.toLocaleString()}. 4, all in, ${q.cap.toLocaleString()}. Escape to cancel.`);
            return;
          }
          if (e.code === 'KeyT') { const to = Math.min(potTo, cap); const lbl = to >= cap ? `All in, ${cap.toLocaleString()}` : `Raise to ${to.toLocaleString()}, pot`; if (_blindHelp) return say(`T: ${lbl}.`); say(`${lbl}.`); if (to >= cap) send('allin'); else send('raise', to); return; }
          if (e.code === 'KeyV') {
            if (_blindHelp) return say('V: Raise a custom amount.');
            const ri = document.querySelector('[data-raise-input]');
            if (ri) { ri.focus(); ri.select?.(); say(`Enter raise amount, minimum ${minTo.toLocaleString()}, then press Return.`); }
            else say('Raise input not available.');
            return;
          }
        }
        if (e.code === 'KeyC') { e.preventDefault(); window.BlindMode.readMyCards?.();  return; }
        if (e.code === 'KeyB') { e.preventDefault(); window.BlindMode.announceBoard?.(); return; }
        if (e.code === 'KeyP') { e.preventDefault(); window.BlindMode.announcePot?.();   return; }
        if (e.code === 'KeyM') { e.preventDefault(); window.BlindMode.announceStack?.();  return; }  // money: total cash
        if (e.code === 'KeyN') { e.preventDefault(); window.BlindMode.announceMyBet?.();  return; }  // bet invested this hand
        const seatKey = e.code.match(/^(?:Digit|Numpad)([1-9])$/);
        if (seatKey) { e.preventDefault(); window.BlindMode.announceSeat?.(parseInt(seatKey[1], 10)); return; }
      }
    });
    document.addEventListener('keyup', (e) => {
      if (!window.BlindMode.isOn() || isTypingTarget(e.target)) return;
      if (e.code === pttCode()) {
        e.preventDefault();
        const chip = $('#blindModeChip');
        if (chip) chip.classList.remove('is-listening');
        window.BlindMode.stopListening();
      }
    });
  })();

  socket.connect();
})();
