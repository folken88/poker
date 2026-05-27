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
  const AUDIO_VOLUME = 0.45;
  // Audio prefs are PER-PLAYER (keyed by player_id in localStorage)
  // so they survive refreshes and tab swaps for as long as the same
  // player is sitting at this browser, but reset for a new player.
  // Defaults: card sounds ON, AI character voices OFF. The "off"
  // default for voice is deliberate — banter chat still shows but
  // the room stays quiet unless the player opts in via the audio menu.
  let _audioMuted = false;          // false = sounds ON
  let _bannerVoiceEnabled = false;  // false = AI voices OFF

  function audioSettingsKey(field) {
    const pid = state.me?.player_id;
    return pid ? `audio.${field}.${pid}` : null;
  }
  function loadAudioSettings() {
    const km = audioSettingsKey('muted');
    const kv = audioSettingsKey('bannerVoice');
    // No state.me yet? Use defaults (don't read the unscoped keys).
    if (km) {
      const raw = localStorage.getItem(km);
      _audioMuted = raw === '1';   // missing → false (sounds on)
    } else _audioMuted = false;
    if (kv) {
      const raw = localStorage.getItem(kv);
      _bannerVoiceEnabled = raw === '1'; // missing → false (voices off)
    } else _bannerVoiceEnabled = false;
    applyMuteUI();
    // After load, republish to server so a fresh reconnect / new
    // player login carries the right preference into the listener
    // count. (Server defaults to false on every connect.)
    pushVoicePrefToServer();
  }
  function saveAudioSettings() {
    const km = audioSettingsKey('muted');
    const kv = audioSettingsKey('bannerVoice');
    if (km) localStorage.setItem(km, _audioMuted ? '1' : '0');
    if (kv) localStorage.setItem(kv, _bannerVoiceEnabled ? '1' : '0');
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

  function applyMuteUI() {
    const btn = $('#muteBtn');
    if (btn) btn.textContent = _audioMuted ? '🔇' : '🔊';
    // Checkboxes read intuitively: ☑ means "this sound is ON".
    // `_audioMuted` is the inverse (mute = NOT on), hence the negation.
    const m = $('#audioMute');         if (m) m.checked = !_audioMuted;
    const v = $('#bannerVoiceToggle'); if (v) v.checked = _bannerVoiceEnabled;
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
  function playBase64Mp3(b64, mime = 'audio/mpeg') {
    try {
      const bin = atob(b64);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.volume = 0.85;
      a.addEventListener('ended', () => URL.revokeObjectURL(url));
      window.BlindMode?.notifyBanterStart?.(a);
      a.play().catch(() => URL.revokeObjectURL(url));
    } catch (_) { /* silent */ }
  }

  // Warm up the cache so the first deal isn't a noticeable buffer
  // delay. Browsers will fetch lazily otherwise.
  for (const url of [...SHUFFLE_POOL, ...DEAL_POOL, ...YOUR_TURN_POOL]) {
    try { new Audio(url).preload = 'auto'; } catch (_) {}
  }

  function playFromPool(pool) {
    if (_audioMuted || !pool.length) return;
    const url = pool[Math.floor(Math.random() * pool.length)];
    try {
      const a = new Audio(url);
      a.volume = AUDIO_VOLUME;
      // Autoplay can be blocked until the user interacts with the page.
      // We don't care — silent rejection just means no SFX that round.
      a.play().catch(() => {});
    } catch (_) { /* silent */ }
  }

  // Trigger state — closed over by maybePlayCardSounds, reset between hands.
  let _audLastHandStartedAt = null;
  let _audLastBoardLen = 0;
  // Tracks whether THIS client was the actor on the previous render.
  // The your-turn chime fires only on the transition false → true so
  // we don't re-chime every render while the player is sitting on
  // their decision.
  let _audWasMyTurn = false;
  function maybePlayCardSounds(hand) {
    if (!hand) {
      _audLastHandStartedAt = null;
      _audLastBoardLen = 0;
      _audWasMyTurn = false;
      return;
    }
    // New hand → shuffle. startedAt is unique-per-hand on the server.
    if (hand.startedAt && hand.startedAt !== _audLastHandStartedAt) {
      _audLastHandStartedAt = hand.startedAt;
      _audLastBoardLen = 0;
      _audWasMyTurn = false;
      playFromPool(SHUFFLE_POOL);
    }
    // Board grew → deal sound (flop/turn/river all trigger).
    const len = hand.board?.length || 0;
    if (len > _audLastBoardLen) {
      _audLastBoardLen = len;
      playFromPool(DEAL_POOL);
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

  function setScreen(name) { document.body.dataset.screen = name; }
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
      renderTable();
      // Keep topbar / sit-out button label in sync with seat state.
      if (state.me) paintMe();
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
          try {
            const a = new Audio(entry.audioUrl);
            a.volume = 0.85;
            window.BlindMode?.notifyBanterStart?.(a);
            a.play().catch(()=>{});
          } catch (_) { /* silent */ }
        } else if (entry.audio) {
          playBase64Mp3(entry.audio, entry.audioMime || 'audio/mpeg');
        }
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
        `;
        pop.classList.add('has-content');
      } else {
        pop.innerHTML = `
          <div class="purse__head">🏦 First Bank of Abadar</div>
          <div class="purse__row"><span>Chips on hand</span><span>${formatChips(chips)} gp</span></div>
          <div class="purse__row purse__row--clear"><span>Loan balance</span><span>—</span></div>
          <div class="purse__foot">You owe nothing. Abadar approves.</div>
        `;
        pop.classList.add('has-content');
      }
    }
  }

  // ===== Table render =====
  function renderTable() {
    const t = state.table; if (!t) return;
    const hand = t.hand;
    // Fire shuffle/deal SFX based on hand + board transitions. Cheap
    // no-op when nothing changed (compares cached timestamps).
    maybePlayCardSounds(hand);
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

      if (seat.occupied) {
        // Determine hole-card display
        let holeHtml = '';
        if (handPlayer) {
          let cards = null;
          if (isMe && state.myHole) cards = state.myHole;
          else if (handPlayer.hole) cards = handPlayer.hole;  // exposed at showdown
          if (cards) {
            holeHtml = `<div class="seat__hole">${cards.map(c => window.FolkenCards.card(c).replace('class="card-svg"', 'class="card-svg ' + (isMe ? 'card-svg--mine' : '') + '"')).join('')}</div>`;
          } else if (!isFolded) {
            holeHtml = `<div class="seat__hole">${window.FolkenCards.faceDown()}${window.FolkenCards.faceDown()}</div>`;
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
          ${badgeHtml}
          ${swordsHtml}
          <div class="seat__plate ${myTurn ? 'seat__plate--acting' : ''}">
            <div class="seat__avatar">${renderAvatar(seat.avatarId)}${avatarBadge}</div>
            <div class="seat__nick" title="${escapeAttr(seat.nickname)}">${escapeText(seat.nickname)}${isAllIn ? ' · ALL-IN' : ''}</div>
            ${botTag}
            <div class="seat__chips">💰 ${formatChips(handPlayer ? handPlayer.stack : seat.chips)} gp</div>
            ${betHtml}
            ${timerHtml}
            ${holeHtml}
            ${actionPanelHtml}
          </div>`;
      } else {
        el.innerHTML = `
          <div class="seat__plate" title="Sit here">
            <div class="seat__empty">Sit ${seat.index + 1}</div>
          </div>`;
        el.addEventListener('click', () => sitDown(seat.index));
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
      if (!tier) return `<span class="seat__gear-cell seat__gear-cell--empty" title="${GEAR_META[slot].label}: not owned">${GEAR_SVGS[slot]}</span>`;
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
        : `<span class="bank__tier bank__tier--off">—</span>`;
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
      .sort((a, b) => b.wealth - a.wealth);
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

  /** Render the player's gear bank into the left-side perimeter panel.
   *  Pulls fresh chip + gear state via buildBankHtml. Called on roster
   *  events and renderTable so seat chip changes mid-hand show up.
   *
   *  Collapsed state is per-tab (sessionStorage). If the user hasn't
   *  expressed a preference, we auto-collapse when there's nothing
   *  actionable — no affordable upgrade AND no item worth hocking — so
   *  the rankings underneath get more room. The user's manual toggle
   *  always overrides the auto-state for the rest of the session. */
  function renderSidebarBank() {
    const el = $('#sidebarBank');
    const toggle = $('#sidebarBankToggle');
    if (!el) return;
    if (!state.me) {
      el.innerHTML = '<p class="sidebar-bank__empty">Pick a character to start your collection.</p>';
      if (toggle) applySidebarBankCollapsed(true);
      return;
    }
    el.innerHTML = buildBankHtml();
    if (!toggle) return;
    // Default expanded. Auto-collapse based on "no affordable upgrade"
    // was hiding the bank when players actually wanted to see it —
    // confusing. The header is now visibly a clickable toggle, so let
    // the user drive it. Saved preference still wins.
    const saved = sessionStorage.getItem('actpanel.bankCollapsed');
    const collapsed = saved !== null ? saved === '1' : false;
    applySidebarBankCollapsed(collapsed);
  }

  /** Walk the current bank state to see if any row has either an
   *  affordable upgrade or a hockable item. Used to decide whether to
   *  auto-collapse the bank when it offers nothing actionable. */
  function _bankHasActions() {
    if (!state.me) return false;
    const t = state.table;
    const mySeat = t?.seats?.find(s => s.playerId === state.me.player_id);
    let gear = mySeat?.gear;
    if (!gear) {
      try { gear = JSON.parse(state.me.gear || '{}') || {}; }
      catch (_) { gear = {}; }
    }
    const chips = mySeat?.chips ?? state.me.chips ?? 0;
    for (const slot of GEAR_SLOTS) {
      const cur = gear[slot] || 0;
      if (cur > 0) return true;                            // hockable
      const cost = gearPrice(slot, 1);                     // cheapest path: +1 fresh
      if (cur < 5 && chips >= (gearPrice(slot, cur + 1) - (cur ? gearPrice(slot, cur) : 0))) return true;
    }
    return false;
  }

  /** Apply collapsed state to DOM + aria. */
  function applySidebarBankCollapsed(collapsed) {
    const toggle = $('#sidebarBankToggle');
    const body   = $('#sidebarBank');
    if (!toggle || !body) return;
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    body.hidden = collapsed;
    const chev = toggle.querySelector('.help-panel__chevron');
    if (chev) chev.textContent = collapsed ? '▸' : '▾';
  }

  // Click handler — record user's preference + apply.
  document.addEventListener('click', (e) => {
    const t = e.target.closest('#sidebarBankToggle');
    if (!t) return;
    const collapsed = t.getAttribute('aria-expanded') === 'true';   // currently expanded → collapsing
    sessionStorage.setItem('actpanel.bankCollapsed', collapsed ? '1' : '0');
    applySidebarBankCollapsed(collapsed);
  });

  /** Legacy no-op — bank now lives inline inside the action panel. */
  function renderBank() { /* see buildBankHtml inside actpanel */ }

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
  }

  // ===== Chat log (bottom panel) =====
  const KIND_CLASS = { hand: 'hand', win: 'win', rebuy: 'rebuy', leave: 'leave', join: 'leave', debt: 'debt', info: 'info', action: 'action', lootlord: 'lootlord', banter: 'banter', human: 'human' };
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
    // Auto-scroll only if user is already near the bottom; don't yank them
    // back if they've scrolled up to read history.
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }
  // Click-to-replay: any chat entry with stored audio re-plays on
  // click. Ignores the voice-toggle gate on the assumption that an
  // explicit user click overrides the global preference — they're
  // asking for this specific line, right now.
  const _chatList = $('#chatList');
  if (_chatList) {
    _chatList.addEventListener('click', (e) => {
      const li = e.target.closest('li.chat-entry');
      if (!li) return;
      const id = Number(li.dataset.chatId);
      if (!Number.isFinite(id)) return;
      const a = _chatAudioById.get(id);
      if (!a) return;
      if (a.audioUrl) {
        try {
          const el = new Audio(a.audioUrl);
          el.volume = 0.85;
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
  $('#resetStackBtn').addEventListener('click', () => {
    const debtNow = Number(state.me?.rebuy_debt || 0);
    const newDebt = debtNow + state.defaultStack;
    const msg = `Re-buy ${state.defaultStack.toLocaleString()} gp?\n\n`
              + `This is a LOAN. Your long-term debt will go from `
              + `${debtNow.toLocaleString()} → ${newDebt.toLocaleString()} gp.\n`
              + `Pay it down later with winnings.`;
    if (!confirm(msg)) return;
    socket.emit('lobby:resetStack', null, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'Could not reset', true); return; }
      state.me.chips = resp.chips;
      state.me.rebuy_debt = resp.rebuyDebt;
      paintMe();
      toast(`Stack reset to ${resp.chips.toLocaleString()} gp. Debt: ${resp.rebuyDebt.toLocaleString()} gp`);
    });
  });

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
  function openBotPicker() {
    const modal = $('#botPickerModal');
    const grid  = $('#botPickerGrid');
    if (!modal || !grid) return;
    const seatedIds = new Set((state.table?.seats || []).filter(s => s.playerId).map(s => s.playerId));
    const allBots = (state.roster || []).filter(p => p.is_bot);
    const bots = allBots
      .filter(p => !seatedIds.has(p.player_id))
      .map(p => ({ p, w: rosterWealth(p) }))
      .sort((a, b) => b.w - a.w);
    if (bots.length === 0) {
      toast(`All ${allBots.length} AI characters are already seated.`, true);
      return;
    }
    grid.innerHTML = bots.map(({ p, w }) => `
      <button type="button" class="bot-picker__card" data-bot-id="${escapeAttr(p.player_id)}" title="${escapeAttr(p.nickname)} · ${formatChips(w)} gp current wealth">
        <div class="bot-picker__avatar">${renderAvatar(p.avatar_id)}</div>
        <div class="bot-picker__nick">${escapeText(p.nickname)}</div>
        <div class="bot-picker__worth">💰 ${formatChips(w)} gp</div>
      </button>
    `).join('');
    modal.hidden = false;
  }
  function closeBotPicker() {
    const m = $('#botPickerModal');
    if (m) m.hidden = true;
  }
  function emitAddBot(playerId) {
    socket.emit('table:addBot', playerId ? { playerId } : null, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'Could not add bot', true); return; }
      const seated = state.roster?.find(p => p.player_id === resp.playerId);
      toast(`${seated?.nickname || 'Bot'} joined the table`);
    });
    closeBotPicker();
  }
  // "+ Bot" = random AI (fast path), "Pick AI ▾" opens the modal picker.
  $('#addBotBtn').addEventListener('click', () => emitAddBot(null));
  $('#pickBotBtn').addEventListener('click', openBotPicker);
  $('#botPickerModal').addEventListener('click', (e) => {
    if (e.target.closest('[data-close-bot-picker]')) { closeBotPicker(); return; }
    if (e.target.closest('#botPickerRandom')) { emitAddBot(null); return; }
    const card = e.target.closest('[data-bot-id]');
    if (card) emitAddBot(card.dataset.botId);
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
    window.BlindMode.init({ state, socket, toast, $ });
    const isTypingTarget = (el) => {
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      return el.isContentEditable === true;
    };
    document.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'Backquote' && !isTypingTarget(e.target)) {
        e.preventDefault();
        window.BlindMode.toggle();
        return;
      }
      if (e.code === 'Space' && window.BlindMode.isOn() && !isTypingTarget(e.target)) {
        e.preventDefault();
        const chip = $('#blindModeChip');
        if (chip) chip.classList.add('is-listening');
        window.BlindMode.startListening();
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && window.BlindMode.isOn() && !isTypingTarget(e.target)) {
        e.preventDefault();
        const chip = $('#blindModeChip');
        if (chip) chip.classList.remove('is-listening');
        window.BlindMode.stopListening();
      }
    });
  })();

  socket.connect();
})();
