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
  };

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
    if (document.body.dataset.screen === 'table') renderTable();
  });

  socket.on('table:hole', ({ playerId, hole }) => {
    if (state.me && playerId === state.me.player_id) {
      state.myHole = hole;
      if (document.body.dataset.screen === 'table') renderTable();
    }
  });

  // ===== Roster picker =====
  function renderRoster() {
    const grid = $('#rosterGrid');
    grid.innerHTML = '';
    for (const p of state.roster) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'roster-pick';
      card.dataset.playerId = p.player_id;
      card.innerHTML = `
        <div class="roster-pick__avatar">${renderAvatar(p.avatar_id)}</div>
        <div class="roster-pick__nick">${escapeText(p.nickname)}</div>
        <div class="roster-pick__chips">💰 ${formatChips(p.chips)}</div>
      `;
      card.addEventListener('click', () => onPickName(p.player_id));
      grid.appendChild(card);
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

  // ===== Confirm =====
  function renderConfirm() {
    const p = state.roster.find(r => r.player_id === state.pendingPlayerId);
    if (!p) { setScreen('roster'); return; }
    $('#confirmNick').textContent = p.nickname;
    $('#confirmAvatarBig').innerHTML = renderAvatar(state.pendingAvatar);
    const grid = $('#confirmAvatarGrid');
    grid.innerHTML = '';
    for (const id of ALL_AVATARS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'avatar-pick';
      btn.role = 'radio';
      btn.dataset.avatar = id;
      btn.setAttribute('aria-checked', id === state.pendingAvatar ? 'true' : 'false');
      btn.innerHTML = renderAvatar(id);
      btn.addEventListener('click', () => {
        state.pendingAvatar = id;
        $('#confirmAvatarBig').innerHTML = renderAvatar(id);
        $$('#confirmAvatarGrid .avatar-pick').forEach(el => {
          el.setAttribute('aria-checked', el.dataset.avatar === id ? 'true' : 'false');
        });
      });
      grid.appendChild(btn);
    }
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
    $('#meNick').textContent = p.nickname;
    $('#meChips').textContent = '💰 ' + formatChips(p.chips);
    $('#meAvatar').innerHTML = renderAvatar(p.avatar_id);
  }

  // ===== Table render =====
  function renderTable() {
    const t = state.table; if (!t) return;
    const hand = t.hand;
    const ring = $('#seatRing');
    ring.innerHTML = '';
    const n = t.seats.length;
    const myId = state.me?.player_id;

    t.seats.forEach((seat, i) => {
      // Position seats on a flatter ellipse so the center (board/pot/stage)
      // has clearance at the top and bottom.
      const angle = (Math.PI * 2 * i) / n + Math.PI / 2;
      const cx = 50 + Math.cos(angle) * 46;
      const cy = 50 + Math.sin(angle) * 33;
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

        const botTag = seat.isBot
          ? `<span class="seat__bot-tag" title="AI player — ${escapeAttr(seat.botMode || 'standard')} mode">AI · ${escapeText(seat.botMode || 'standard')}</span>`
          : (seat.isAfk
              ? `<span class="seat__afk-tag" title="Disconnected — sitting out until they return">AFK · sitting out</span>`
              : '');
        // Build the inline action panel for ME-when-it's-my-turn.
        const myTurn = isMe && isActor && handPlayer && !handPlayer.folded && !handPlayer.allIn
          && hand.state !== 'SHOWDOWN' && hand.state !== 'COMPLETE';
        const actionPanelHtml = myTurn ? buildActionPanelHtml(hand, handPlayer) : '';
        el.innerHTML = `
          <div class="seat__plate ${myTurn ? 'seat__plate--acting' : ''}">
            ${badgeHtml}
            <div class="seat__avatar">${renderAvatar(seat.avatarId)}</div>
            <div class="seat__nick" title="${escapeAttr(seat.nickname)}">${escapeText(seat.nickname)}${isAllIn ? ' · ALL-IN' : ''}</div>
            ${botTag}
            <div class="seat__chips">💰 ${formatChips(handPlayer ? handPlayer.stack : seat.chips)}</div>
            ${betHtml}
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
    $('#pot').textContent = 'Pot ' + formatChips(potTotal);
    $('#pot').style.opacity = hand ? 1 : 0.3;

    const seated = t.seats.filter(s => s.occupied).length;
    const stage = hand ? hand.state : 'WAITING';
    $('#stageBanner').textContent = stageLabel(stage, seated, t.spectatorCount);

    // Winner banner
    renderWinnerBanner(hand);

    // Action bar
    renderActionBar(hand);
  }

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

  function renderWinnerBanner(hand) {
    const banner = $('#handBanner');
    if (!hand || (hand.state !== 'COMPLETE' && hand.state !== 'SHOWDOWN')) {
      banner.hidden = true;
      banner.textContent = '';
      return;
    }
    const lines = hand.winners.map(w => {
      const seat = state.table.seats.find(s => s.playerId === w.playerId);
      const nick = seat?.nickname || w.playerId;
      return `${nick} wins ${formatChips(w.amount)} — ${w.handDesc}`;
    });
    banner.innerHTML = lines.join('<br>');
    banner.hidden = false;
  }

  /**
   * Inline action panel HTML, rendered under the player's own seat when
   * it's their turn. Compact layout with Fold / Check|Call / Raise / All-in
   * and a row of preset raise-to amounts that fill the editable input.
   */
  function buildActionPanelHtml(hand, me) {
    const toCall = Math.max(0, hand.currentBet - me.invested);
    const minRaiseTo = Math.max(hand.currentBet + hand.minRaise, hand.currentBet + 1);
    const maxRaiseTo = me.invested + me.stack;        // shove
    const potNow = hand.potTotal;
    const bb = hand.minRaise || 50;

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

    const callOrCheck = toCall === 0
      ? `<button class="btn btn--primary actpanel__btn" data-act="check">Check</button>`
      : `<button class="btn btn--primary actpanel__btn" data-act="call">Call ${formatChips(Math.min(toCall, me.stack))}</button>`;

    const presetHtml = presets.map(p =>
      `<button type="button" class="actpanel__preset" data-raise="${p.value}">${p.label} · ${formatChips(p.value)}</button>`
    ).join('');

    return `
      <div class="actpanel" data-actpanel>
        <div class="actpanel__status">to call ${formatChips(toCall)} · pot ${formatChips(potNow)}</div>
        <div class="actpanel__row">
          <button class="btn btn--ghost actpanel__btn" data-act="fold">Fold</button>
          ${callOrCheck}
          <button class="btn btn--danger actpanel__btn" data-act="allin">All-in</button>
        </div>
        <div class="actpanel__row actpanel__row--raise">
          <input type="number" class="actpanel__amount" data-raise-input
                 min="${minRaiseTo}" max="${maxRaiseTo}"
                 placeholder="≥ ${formatChips(minRaiseTo)}" />
          <button class="btn btn--accent actpanel__btn" data-act="raise">Raise to</button>
        </div>
        <div class="actpanel__presets">${presetHtml}</div>
      </div>`;
  }

  /** Tiny "waiting on X" status only — main controls live in the seat. */
  function renderActionBar(hand) {
    const bar = $('#actionWait');
    const myId = state.me?.player_id;
    if (!hand || !myId) { bar.hidden = true; return; }
    const me = hand.players.find(p => p.playerId === myId);
    if (!me) { bar.hidden = true; return; }
    const isMyTurn = hand.actor === myId;
    if (isMyTurn || me.folded || me.allIn ||
        hand.state === 'SHOWDOWN' || hand.state === 'COMPLETE') {
      bar.hidden = true;
      return;
    }
    const actorSeat = state.table.seats.find(s => s.playerId === hand.actor);
    const actorNick = actorSeat?.nickname || hand.actor || 'someone';
    $('#actionStatus').textContent = `Waiting on ${actorNick}…`;
    bar.hidden = false;
  }

  function sitDown(seatIndex) {
    socket.emit('table:sit', { seatIndex }, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'Could not sit', true); return; }
      toast(`Seated at #${resp.seatIndex + 1}`);
    });
  }

  // ===== Action panel wiring (delegated; panel is re-rendered each turn) =====
  $('#seatRing').addEventListener('click', (e) => {
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
    e.stopPropagation();   // don't bubble to sit-down handler
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

  // ===== Topbar =====
  $('#resetStackBtn').addEventListener('click', () => {
    if (!confirm('Reset your chip stack to ' + state.defaultStack + '?')) return;
    socket.emit('lobby:resetStack', null, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'Could not reset', true); return; }
      state.me.chips = resp.chips;
      paintMe();
      toast(`Stack reset to ${resp.chips}`);
    });
  });
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

  $('#addBotBtn').addEventListener('click', () => {
    socket.emit('table:addBot', null, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'Could not add bot', true); return; }
      toast('Bot joined the table');
    });
  });
  $('#removeBotBtn').addEventListener('click', () => {
    socket.emit('table:removeBot', null, (resp) => {
      if (!resp?.ok) { toast(resp?.error || 'No bot to remove', true); return; }
      toast('Bot removed');
    });
  });

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
        if (resp?.ok) toast('Game reset — everyone back to ' + formatChips(state.defaultStack));
        else toast(resp?.error || 'Reset failed', true);
      });
    }
  });

  // ===== Helpers =====
  function escapeText(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])); }
  function escapeAttr(s) { return String(s ?? '').replace(/["&<>]/g, c => ({ '"':'&quot;','&':'&amp;','<':'&lt;','>':'&gt;' }[c])); }
  function formatChips(n) { return Number(n || 0).toLocaleString(); }
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

  socket.connect();
})();
