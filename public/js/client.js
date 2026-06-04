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
            const g = ctx.createGain(); g.gain.value = _voiceVolume * VOICE_MUFFLE_VOL;
            srcNode.connect(lp); lp.connect(g); g.connect(ctx.destination);
            a.addEventListener('ended', () => { URL.revokeObjectURL(url); try { srcNode.disconnect(); lp.disconnect(); g.disconnect(); } catch (_) {} done(); });
            a.play().catch(() => { URL.revokeObjectURL(url); done(); });
            return;
          } catch (_) { /* fall through to plain playback */ }
        }
      }
      const a = new Audio(url);
      a.volume = _voiceVolume;
      a.addEventListener('ended', () => { URL.revokeObjectURL(url); done(); });
      window.BlindMode?.notifyBanterStart?.(a);
      a.play().catch(() => { URL.revokeObjectURL(url); done(); });
    } catch (_) { done(); }
  }

  // Serialize AI banter voices so two characters never talk over each other — each
  // 11labs clip plays in FULL (its own end event marks its real length) before the
  // next starts. A safety timer advances the queue if an end event never fires.
  const _voiceQueue = [];
  let _voiceBusy = false, _voiceFallback = null;
  function enqueueVoice(b64, mime, muffle = false) {
    if (!b64) return;
    _voiceQueue.push({ b64, mime: mime || 'audio/mpeg', muffle: !!muffle });
    while (_voiceQueue.length > 4) _voiceQueue.shift();   // don't pile up stale lines
    _drainVoiceQueue();
  }
  function _drainVoiceQueue() {
    if (_voiceBusy) return;
    const next = _voiceQueue.shift();
    if (!next) return;
    _voiceBusy = true;
    let advanced = false;
    const advance = () => { if (advanced) return; advanced = true; clearTimeout(_voiceFallback); _voiceBusy = false; _drainVoiceQueue(); };
    _voiceFallback = setTimeout(advance, 15000);   // hard safety so the queue can never stall
    playBase64Mp3(next.b64, next.mime, next.muffle, advance);
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
    audioMenu.addEventListener('click', (e) => {
      audioMenu.classList.toggle('is-open');
    });
    document.addEventListener('click', (e) => {
      if (audioMenu.contains(e.target)) return;
      audioMenu.classList.remove('is-open');
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
  function setScreen(name) {
    document.body.dataset.screen = name;
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
  let _dungeonSoundSeen = 0;   // highest dungeon-log id whose sound we've played
  let _recruitOpen = false;    // dungeon "Recruit AI ▾" dropdown open/closed
  let _spellbookOpen = false;  // caster "📖 Spellbook ▾" dropdown open/closed
  let _spectating = false;     // watching the dungeon (not a combatant) — heckle-only

  function playDungeonSound(url, vol) {
    if (!url || !combatSoundEnabled(url)) return;   // honors the combat-sound toggles
    try { const a = new Audio(url); a.volume = Math.max(0, Math.min(1, vol)); a.play().catch(() => {}); } catch (_) {}
  }
  function enterDungeon() {
    socket.emit('dungeon:enter', null, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'Could not enter the dungeon.', true); return; }
      _inDungeon = true; _spectating = false; _dungeonSel = []; _dungeonSoundSeen = 0;
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
  function dungeonAction(kind, payload) {
    socket.emit('dungeon:action', { kind, ...(payload || {}) }, (resp) => {
      if (resp && resp.ok === false && resp.error) toast(resp.error, true);
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

  socket.on('dungeon:state', (st) => {
    state.dungeon = st;
    // Play the single newest log sound at full volume (this client is IN the
    // dungeon, so it hears combat clearly — the table hears the muffled echo).
    if (st.log && st.log.length) {
      let topT = _dungeonSoundSeen, topSound = null, maxT = _dungeonSoundSeen;
      for (const e of st.log) {
        if (e.t > maxT) maxT = e.t;
        if (e.t > _dungeonSoundSeen && e.sound && e.t >= topT) { topT = e.t; topSound = e.sound; }
      }
      if (topSound) playDungeonSound(topSound, _combatVolume);
      _dungeonSoundSeen = maxT;
    }
    if (document.body.dataset.screen === 'dungeon') renderDungeon();
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
    return `<div class="dcond">` + list.map(c =>
      `<img class="dcond__i" src="${escapeAttr(c.icon)}" alt="${escapeAttr(c.label)}" title="${escapeAttr(statusTitle(c))}" loading="lazy" />`
    ).join('') + `</div>`;
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
  function renderDungeon() {
    const d = state.dungeon;
    if (!d) return;
    const meId = state.me?.player_id;
    const turnId = (d.turn && d.turn.kind === 'party') ? d.turn.id : null;
    const isMyTurn = turnId === meId;
    const turnName = turnId ? ((d.party || []).find(m => m.playerId === turnId)?.nickname || 'someone') : null;

    const meta = $('#dungeonMeta');
    if (meta) meta.textContent = `Depth ${d.depth} · Round ${d.round || 0} · 💰 ${formatChips(d.runGold)} gp pool`;

    const ene = $('#dungeonEnemies');
    if (ene) ene.innerHTML = (d.enemies || []).length
      ? d.enemies.map(e => {
          const dead = !e.alive;
          const sel = !dead && _dungeonSel.includes(e.uid);
          const pct = e.maxHp ? Math.max(0, Math.round(100 * e.hp / e.maxHp)) : 0;
          const portrait = e.art
            ? `<div class="dmon__art" style="background-image:url('${escapeAttr(e.art)}')">${e.boss ? '<span class="dmon__crown">👑</span>' : ''}</div>`
            : `<div class="dmon__glyph">${e.glyph || '❓'}${e.boss ? ' 👑' : ''}</div>`;
          return `<button type="button" class="dmon ${dead ? 'is-dead' : ''} ${sel ? 'is-sel' : ''} ${e.boss ? 'is-boss' : ''}" data-enemy="${escapeAttr(e.uid)}" ${dead ? 'disabled' : ''}>
            ${portrait}
            <div class="dmon__name">${escapeText(e.name)}${e.flying ? ` <span class="dmon__fly" title="Flying — immune to prone (can't be tripped); holds the high ground: +1 to hit and +2 AC vs grounded heroes">🪽</span>` : ''}</div>
            ${condIcons(e.conditions)}
            <div class="dmon__hpbar"><span style="width:${pct}%"></span></div>
            <div class="dmon__hp">${dead ? '☠️' : `${e.hp}/${e.maxHp}`}${e.cr ? ` · CR ${e.cr}` : ''}${(typeof e.ac === 'number') ? ` · <span title="AC ${e.ac} · touch ${e.touchAC} (spells & guns) · flat-footed ${e.ffAC}">AC ${e.ac}<span class="dmon__acsub"> ${e.touchAC}t/${e.ffAC}ff</span></span>` : ''}</div>
          </button>`;
        }).join('')
      : '<div class="dmon__none">— the room is quiet —</div>';
    // Static battlefield box: shrink the cards as the field fills so a crowded
    // room never spills past the box / pushes the spellbook off-screen.
    if (ene) {
      const n = (d.enemies || []).length;
      ene.classList.toggle('is-compact', n > 6 && n <= 12);
      ene.classList.toggle('is-packed', n > 12);
    }

    const party = $('#dungeonParty');
    if (party) party.innerHTML = (d.party || []).map(m => {
      const pct = m.maxHp ? Math.max(0, Math.round(100 * m.hp / m.maxHp)) : 0;
      const isMe = m.playerId === meId;
      const isTurn = m.playerId === turnId;
      const cls = ['dpc']; if (pct <= 30) cls.push('is-low'); if (m.dead || m.left) cls.push('is-out'); if (m.downed) cls.push('is-down'); if (isMe) cls.push('is-me'); if (isTurn) cls.push('is-turn');
      const tag = m.dead ? ' ☠️' : m.downed ? ' 🩸' : m.left ? ' 🪜' : '';
      const hpText = m.downed
        ? `${typeof m.dyingHp === 'number' ? m.dyingHp : 0}/${m.maxHp} HP · 🩸 DYING`
        : `${Math.max(0, m.hp)}/${m.maxHp} HP${m.level ? ` · Lv ${m.level}${m.maxLevel ? ' (max)' : (typeof m.xpToNext === 'number' ? ` · ${m.xpToNext.toLocaleString()} XP→next` : '')}` : ''}`;
      // Auto-skip countdown badge — only on the human whose turn it is, just to
      // the right of their token. Live-ticked by the interval below.
      const afk = m.afkAt
        ? `<span class="dpc__afk" data-afk-at="${m.afkAt}" title="You'll auto-skip if idle">⏱ ${Math.max(0, Math.ceil((m.afkAt - Date.now()) / 1000))}s</span>`
        : '';
      return `<div class="${cls.join(' ')}">
        <div class="dpc__avatar"${m.crowned ? ' style="position:relative"' : ''}>${renderAvatar(m.avatarId)}${m.crowned ? `<span class="dpc__crown" title="Loot Lord" style="position:absolute;top:-8px;left:50%;transform:translateX(-50%);font-size:1.05em;line-height:1;z-index:6;pointer-events:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.7))">👑</span>` : ''}</div>${afk}
        <div class="dpc__name">${escapeText(m.nickname)}${isMe ? ' (you)' : ''}${m.isBot ? ' 🤖' : ''}${tag}</div>
        ${condIcons(m.conditions)}${buffIcons(m.buffs)}
        <div class="dpc__hpbar"><span style="width:${pct}%"></span></div>
        <div class="dpc__hp">${hpText}</div>
      </div>`;
    }).join('');

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
        // Spells are only castable on your turn — so the Spellbook popover has no
        // reason to stay open when the turn/round ends. Force it shut whenever it
        // isn't your turn; otherwise a round ending with it open leaves the
        // popover covering the door/attack/spectate buttons with no way to
        // dismiss it (soft-lock → had to leave the dungeon).
        if (!myTurn) _spellbookOpen = false;
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
          const ok = ab.cost === 'free' ? true : (ab.remaining > 0);
          const count = (ab.cost === 'room' || ab.cost === 'run')
            ? ` <span class="dungeon__uses" title="${ab.cost === 'run' ? 'once per dungeon' : 'per room'}">${ab.remaining}/${ab.max}</span>` : '';
          const tgt = ab.maxTargets > 1 ? ` <span class="dungeon__uses">×${ab.maxTargets}</span>` : '';
          return `<button class="btn btn--ghost" data-dact="ability" data-slot="${slot}" data-abkey="${escapeAttr(ab.key || '')}"${(myTurn && ok) ? '' : ' disabled'} title="${escapeAttr(ab.desc || '')}">${ic(ab)}${escapeText(ab.name)}${tgt}${count}</button>`;
        };
        // Spellbook tile: icon ONLY (name + short description show on hover).
        // A corner badge carries the uses-left count, or 🔒 when level-locked.
        const spellIcon = (ab, slot) => {
          const locked = !ab.available;
          const ok = !locked && (ab.cost === 'free' ? true : (ab.remaining > 0));
          const dis = !myTurn || !ok;
          const cnt = (ab.cost === 'room' || ab.cost === 'run') && ab.max ? `${ab.remaining}/${ab.max}` : '';
          const badge = locked ? `<span class="dungeon__sb-badge dungeon__sb-lock">🔒</span>`
                      : (cnt ? `<span class="dungeon__sb-badge">${cnt}</span>` : '');
          const tgt = ab.maxTargets > 1 ? ` · up to ${ab.maxTargets} foes` : '';
          const lk  = locked ? ` — unlocks at level ${ab.minLevel}` : '';
          const title = `${ab.name}${tgt}${lk}${ab.desc ? ' — ' + ab.desc : ''}`;
          return `<button class="dungeon__sb-spell${locked ? ' is-locked' : ''}" data-dact="ability" data-slot="${slot}"${dis ? ' disabled' : ''} title="${escapeAttr(title)}" aria-label="${escapeAttr(ab.name)}">${ic(ab)}${badge}</button>`;
        };
        const atName = `${kit.atwill.img ? ic(kit.atwill) : (kit.atwill.icon || '⚔️') + ' '}${escapeText(kit.atwill.name || 'Attack')}`;
        const pool = kit.spellPool ? ` · ✨ ${kit.spellPool.remaining}/${kit.spellPool.max} casts` : '';
        const status = combat
          ? (myTurn ? `⚔️ Your turn${pool}` : (turnName ? escapeText(turnName) + ' is acting…' : 'Enemies acting…'))
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
            if (ab.slvl == null) { features.push({ ab, i }); return; }
            if (!spellsByLvl.has(ab.slvl)) spellsByLvl.set(ab.slvl, []);
            spellsByLvl.get(ab.slvl).push(spellIcon(ab, i));
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
          abilHtml = (kit.abilities || []).map((ab, i) => abilBtn(ab, i)).join('');
        }
        acts.innerHTML =
          `<div class="dungeon__actstatus">${status}</div>` +
          `<div class="dungeon__actrow dungeon__actrow--abilities">` +
            B('attack', atName, myTurn, combat) +
            abilHtml +
          `</div>` +
          `<div class="dungeon__actrow dungeon__actrow--nav">` +
            B('door', '🚪 Open door', !combat && !rolling, !combat) +
            `<button class="btn btn--ghost" data-dact="spectate" title="Bank your gold and leave the fight — but keep watching from the sidelines">👁 Spectate</button>` +
          `</div>`;
      }
    }

    // Recruit panel — unseated AI bots you can bring along (50g each). Uses
    // the same card style as the poker "Pick AI" picker.
    const recruit = $('#dungeonRecruit');
    if (recruit) {
      const list = d.recruitable || [];
      const full = (d.botCount || 0) >= 3;
      if (d.status === 'over' || !list.length || _spectating) { recruit.innerHTML = ''; _recruitOpen = false; }
      else recruit.innerHTML =
        `<button type="button" class="btn btn--ghost btn--sm dungeon__recruit-toggle" data-recruit-toggle aria-expanded="${_recruitOpen}">🤝 Recruit AI ▾ <span class="dungeon__recruit-count">${list.length}</span></button>` +
        `<div class="dungeon__recruit-pop ${_recruitOpen ? 'is-open' : ''}">` +
          `<div class="dungeon__recruit-head">Unseated allies — 50g each${full ? ' · party full' : ''}</div>` +
          `<div class="bot-picker__grid bot-picker__grid--dungeon">` +
          list.map(b => `<button type="button" class="bot-picker__card" data-recruit="${escapeAttr(b.playerId)}" ${full ? 'disabled' : ''} title="${escapeAttr(b.nickname)} — ${escapeAttr(dungeonGearTip(b.gear))} · 💰 ${formatChips(b.wealth)} gp · recruit for ${b.fee}g">
              <div class="bot-picker__avatar">${renderAvatar(b.avatarId)}</div>
              <div class="bot-picker__nick">${escapeText(b.nickname)}</div>
              <div class="bot-picker__worth">🤝 ${b.fee}g</div>
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
  $('#dungeonEnemies')?.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-enemy]'); if (!b) return;
    const uid = b.dataset.enemy;
    const i = _dungeonSel.indexOf(uid);
    if (i >= 0) _dungeonSel.splice(i, 1);
    else { _dungeonSel.push(uid); if (_dungeonSel.length > 2) _dungeonSel.shift(); }
    renderDungeon();
  });
  $('#dungeonActions')?.addEventListener('click', (ev) => {
    // Spellbook expand/collapse (caster classes).
    if (ev.target.closest('[data-spellbook-toggle]')) { _spellbookOpen = !_spellbookOpen; renderDungeon(); return; }
    const b = ev.target.closest('[data-dact]'); if (!b || b.disabled) return;
    const act = b.dataset.dact;
    if (act === 'attack')       dungeonAction('attack', { targetUid: _dungeonSel[0] });
    else if (act === 'ability') {
      const payload = { slot: Number(b.dataset.slot) || 0, targetUid: _dungeonSel[0], targetUids: _dungeonSel.slice(0, 6) };
      // Inquisitor Bane declares a creature TYPE: take it from the selected foe
      // (if any). With nothing selected the server auto-picks the commonest type.
      if (b.dataset.abkey === 'bane') {
        const sel = (state.dungeon?.enemies || []).find(e => e.uid === _dungeonSel[0] && e.alive);
        if (sel && sel.type) payload.baneType = sel.type;
      }
      dungeonAction('ability', payload); _spellbookOpen = false;
    }
    else if (act === 'door')    dungeonAction('door');
    else if (act === 'bail')    dungeonAction('bail');
    else if (act === 'join')    enterDungeon();        // spectator → combatant
    else if (act === 'spectate') bailToSpectate();     // combatant → spectator (keeps watching)
    else if (act === 'leave')   returnFromDungeon();
    if (act === 'attack' || act === 'ability') _dungeonSel = [];
  });
  // The Spellbook is a popover that overlays the other action buttons, so it
  // must always be dismissable: a click anywhere outside its wrap — or Escape —
  // closes it. (Belt-and-suspenders with the auto-close on !myTurn above, which
  // handles the round-ended-with-it-open soft-lock.)
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
  $('#dungeonRecruit')?.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-recruit-toggle]')) {
      _recruitOpen = !_recruitOpen;
      const pop = $('#dungeonRecruit')?.querySelector('.dungeon__recruit-pop');
      if (pop) pop.classList.toggle('is-open', _recruitOpen);
      const tog = $('#dungeonRecruit')?.querySelector('[data-recruit-toggle]');
      if (tog) tog.setAttribute('aria-expanded', String(_recruitOpen));
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
      if (resp?.ok) input.value = '';
      else toast(resp?.error || 'Could not send', true);
    });
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
          else {
            try {
              const a = new Audio(entry.audioUrl);
              a.volume = _voiceVolume;
              window.BlindMode?.notifyBanterStart?.(a);
              a.play().catch(()=>{});
            } catch (_) { /* silent */ }
          }
        } else if (entry.audio) {
          playBase64Mp3(entry.audio, entry.audioMime || 'audio/mpeg', _inDungeon);   // muffle when down in the dungeon
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
        JG: 'Jade Regent',
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
        const avatarBadge = seat.isBot
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
    weapon: { label: 'Longsword',              short: 'Weapon', mw: 315,  mult: 2000 },
    armor:  { label: 'Full Plate',             short: 'Armor',  mw: 1650, mult: 1000 },
    shield: { label: 'Heavy Steel Shield',     short: 'Shield', mw: 170,  mult: 1000 },
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
        const t = slot === 'armor' ? 'Chain Shirt (+4 AC) — Full Plate not owned' : `${GEAR_META[slot].label}: not owned`;
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
            ? `<span class="bank__tier bank__tier--off" title="Chain Shirt — free baseline armor (+4 AC) until you buy Full Plate">Chain</span>`
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
    function wealthOf(p) {
      // Net worth = chips + market value of all gear − outstanding
      // First Bank of Abadar debt. Debt drags the score down so the
      // leaderboard truthfully reflects "what you'd be worth if you
      // settled up tomorrow." Bots have rebuy_debt always = 0.
      let total = Number(p.chips || 0);
      try {
        const gear = JSON.parse(p.gear || '{}') || {};
        for (const slot of GEAR_SLOTS) {
          const tier = gear[slot] || 0;
          if (tier) total += gearPrice(slot, tier);
        }
      } catch (_) {}
      total -= Number(p.rebuy_debt || 0);
      return total;
    }
    // Hide players sitting at exactly 5,000 net worth — that's the
    // default starting stack, so a flat 5,000 almost always means
    // "never played this game". Keeping them off the board makes the
    // leaderboard reflect actual results. Anyone above OR below 5,000
    // shows up.
    const ranked = all
      .map(p => ({ p, wealth: wealthOf(p) }))
      .filter(({ wealth }) => wealth !== 5000)
      .sort((a, b) => b.wealth - a.wealth)
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
          <span class="lb__wealth">${formatChips(row.wealth)} gp</span>
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
      if (!rec) {
        el.innerHTML = `<span class="lb-records__label">${label}</span><span class="lb-records__empty">—</span>`;
        continue;
      }
      const when = rec.ts ? new Date(rec.ts).toLocaleDateString() : '';
      const tip = `${rec.nick}${rec.hand ? ' · ' + rec.hand : ''}${when ? ' · ' + when : ''}`;
      el.innerHTML = `<span class="lb-records__label">${label}</span>`
        + `<span class="lb-records__who" title="${escapeAttr(tip)}">${escapeText(rec.nick)}</span>`
        + `<span class="lb-records__amt ${cls}">${valFn(rec)}</span>`;
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
    const all = (state.roster || []).slice();
    if (all.length === 0) { el.innerHTML = '<li class="lb__empty">No players yet…</li>'; return; }
    const meId = state.me?.player_id;
    function wealthOf(p) {
      // Net worth = chips + market value of all gear − outstanding
      // First Bank of Abadar debt. Debt drags the score down so the
      // leaderboard truthfully reflects "what you'd be worth if you
      // settled up tomorrow." Bots have rebuy_debt always = 0.
      let total = Number(p.chips || 0);
      try {
        const gear = JSON.parse(p.gear || '{}') || {};
        for (const slot of GEAR_SLOTS) {
          const tier = gear[slot] || 0;
          if (tier) total += gearPrice(slot, tier);
        }
      } catch (_) {}
      total -= Number(p.rebuy_debt || 0);
      return total;
    }
    // Same 5,000-flat filter as the popup leaderboard — hide players
    // sitting at the default starting stack with zero gear/debt; that
    // signature means "never played."
    const ranked = all
      .map(p => ({ p, wealth: wealthOf(p) }))
      .filter(({ wealth }) => wealth !== 5000)
      .filter(({ p }) => _lbFilter === 'all' || !p.is_bot)   // Hu = humans only (default)
      .sort((a, b) => b.wealth - a.wealth);
    if (!ranked.length) { el.innerHTML = `<li class="lb__empty">${_lbFilter === 'all' ? 'No players yet…' : 'No human players yet…'}</li>`; return; }
    el.innerHTML = ranked.map((row, i) => {
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
          <span class="lb__wealth">${formatChips(row.wealth)}</span>
        </li>`;
    }).join('');
  }

  // ===== Loot Bank "paper doll" popover =====
  // The "🎒 My Loot Bank" button stays collapsed; clicking it pops up a paper
  // doll of the player's equipped gear (buy / hock per slot). Dismisses on a
  // click outside, the ✕, or Escape.
  let _bankDollOpen = false;
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
      ? `<button type="button" class="bank__btn bank__btn--buy" ${canAfford ? '' : 'disabled'} data-buy-slot="${slot}" data-buy-tier="${next}" title="${cur ? 'Upgrade to' : 'Buy a'} +${next} ${meta.label} — ${upgradeCost.toLocaleString()} gp">${cur ? '⬆ +' : 'Buy +'}${next} · ${formatChips(upgradeCost)}</button>`
      : `<button type="button" class="bank__btn bank__btn--max" disabled>+5 ✓</button>`;
    const sellBtn = cur
      ? `<button type="button" class="bank__btn bank__btn--sell" data-sell-slot="${slot}" title="Hock for ${sellValue.toLocaleString()} gp (50% market)">Hock +${formatChips(sellValue)}</button>`
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
  }
  function closeBankDoll() {
    const el = $('#bankDoll'); if (el) el.hidden = true;
    _bankDollOpen = false;
    _bankToggles().forEach(b => b.setAttribute('aria-expanded', 'false'));
  }
  // Re-render the open doll when chips/gear change (called on roster/table state).
  function renderSidebarBank() { if (_bankDollOpen) { const el = $('#bankDoll'); if (el) el.innerHTML = buildPaperDollHtml(); } }
  function renderBank() { /* legacy no-op — gear bank also lives in the action panel */ }

  $('#sidebarBankToggle')?.addEventListener('click', (e) => { e.stopPropagation(); _bankDollOpen ? closeBankDoll() : openBankDoll($('#sidebarBankToggle')); });
  $('#dungeonBankToggle')?.addEventListener('click', (e) => { e.stopPropagation(); _bankDollOpen ? closeBankDoll() : openBankDoll($('#dungeonBankToggle')); });
  $('#bankDoll')?.addEventListener('click', (e) => { if (e.target.closest('[data-bank-close]')) closeBankDoll(); });
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
      if (a.audioUrl) {
        try {
          const el = new Audio(a.audioUrl);
          el.volume = _voiceVolume;
          window.BlindMode?.notifyBanterStart?.(el);
          el.play().catch(()=>{});
        } catch (_) {}
      } else if (a.audio) {
        playBase64Mp3(a.audio, a.audioMime || 'audio/mpeg');
      }
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

  // ===== Combined timer tick: seat countdowns AND the big topbar clock =====
  function tickTimers() {
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
        if (!resp?.ok) { toast(resp?.error || 'Could not buy', true); return; }
      });
      return;
    }
    // Bank: sell / hock
    const sell = e.target.closest('[data-sell-slot]');
    if (sell) {
      e.preventDefault();
      const slot = sell.dataset.sellSlot;
      socket.emit('lobby:sellGear', { slot }, (resp) => {
        if (!resp?.ok) { toast(resp?.error || 'Could not sell', true); return; }
        toast(`Hocked your ${GEAR_META[slot].label} for ${formatChips(resp.refund)} gp`);
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
    const opt = (w, bad) =>
      `<option value="${w.key}"${bad ? ' class="weapon-nonprof" style="color:#cc5500"' : ''}>`
      + `${w.name} (${w.dmg})${bad ? ` — ${pen} non-prof` : ''}</option>`;
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
      // H — re-read my hand (hole cards + board) any time.
      if (e.code === 'KeyH') {
        e.preventDefault();
        window.BlindMode.readHand?.();
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
