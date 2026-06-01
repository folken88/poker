/**
 * Append-only JSONL loggers for offline analysis.
 *   - hands.jsonl         — one row per completed hand (board, players, actions, winners)
 *   - bot-decisions.jsonl — one row per bot decision (context + chosen action + reason)
 *   - conversation.jsonl  — one row per chat-funnel line: every banter line,
 *                           human chat, AND gameplay narration (actions, wins,
 *                           hand markers, rebuys, etc.) in chronological order,
 *                           each timestamped. The single transcript that shows
 *                           "how things are going" — what was said and done, in
 *                           sequence — for verifying banter quality (e.g. a bot
 *                           misreading a bet) against the surrounding gameplay.
 *
 * Files live in /app/logs which is bind-mounted to backend/logs on the host so
 * we can tail/read them without entering the container.
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { strengthOf } = require('../bot/strength');
const { Hand: SolverHand } = require('pokersolver');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const HAND_LOG = path.join(LOG_DIR, 'hands.jsonl');
const BOT_LOG  = path.join(LOG_DIR, 'bot-decisions.jsonl');
const CHAT_LOG = path.join(LOG_DIR, 'conversation.jsonl');

function appendLine(file, obj) {
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch (e) {
    console.error('[logger]', file, e.message);
  }
}

function logHand({ tableId, hand, durationMs }) {
  const row = {
    ts: new Date().toISOString(),
    table: tableId,
    durationMs,
    smallBlind: hand.smallBlind,
    bigBlind: hand.bigBlind,
    board: hand.board,
    players: hand.players.map(p => ({
      playerId: p.playerId,
      nickname: p.nickname,
      seatIndex: p.seatIndex,
      hole: p.hole,
      stackStart: p.stack + p.totalIn - winningsFor(hand.winners, p.playerId),
      stackEnd:   p.stack,
      totalIn:    p.totalIn,
      folded:     p.folded,
      allIn:      p.allIn,
    })),
    pots: hand.pot.buildSidePots().map(p => ({ amount: p.amount, eligible: [...p.eligible] })),
    winners: hand.winners,
    events: hand.events,
  };
  appendLine(HAND_LOG, row);
  _applyHandRecords(row);
}

function winningsFor(winners, playerId) {
  return winners.filter(w => w.playerId === playerId).reduce((s, w) => s + w.amount, 0);
}

// ── All-time "Hall of Records" — fun per-hand extremes ──────────────────────
// Persisted implicitly through hands.jsonl: seeded by scanning the log at boot
// (below), then updated as each hand is logged. NOT cleared by Full Reset.
//   biggestWin/Loss : most chips netted / lost by a player in one hand
//   biggestPot      : largest total pot fought over (attributed to its winner)
//   longestWar      : most raises/all-ins in one hand (a betting slugfest)
//   biggestBluff    : biggest pot stolen uncontested with a weak hand
//   ugliestWinner   : weakest made hand to win a shown-down pot
const _records = {
  biggestWin: null, biggestLoss: null, biggestPot: null,
  longestWar: null, biggestBluff: null, ugliestWinner: null,
};

// Only players in the CURRENT roster (code-defined ROSTER + BOT_ROSTER) count —
// so a long-gone test player (e.g. "OldOwl") who still lives in hands.jsonl
// can't hold the board. Built lazily + cached; the roster only changes at boot.
let _currentIds = null;
function _currentSet() {
  if (_currentIds) return _currentIds;
  try {
    _currentIds = new Set([
      ...(db.ROSTER || []).map(p => String(p.name).toLowerCase()),
      ...(db.BOT_ROSTER || []).map(p => String(p.name).toLowerCase()),
    ]);
  } catch (_) { _currentIds = new Set(); }
  return _currentIds;
}
const _isCurrent = (pid) => _currentSet().has(String(pid || '').toLowerCase());

function _applyHandRecords(h) {
  if (!h) return;
  const ts = h.ts;
  const players = h.players || [];
  const board = h.board || [];

  // 1) Biggest single-hand WIN / LOSS (per current player's net).
  for (const p of players) {
    if (!_isCurrent(p.playerId)) continue;
    const net = (p.stackEnd || 0) - (p.stackStart || 0);
    if (!Number.isFinite(net) || net === 0) continue;
    const who = { nick: p.nickname || p.playerId, amount: Math.abs(net), ts };
    if (net > 0) {
      if (!_records.biggestWin || net > _records.biggestWin.amount) _records.biggestWin = who;
    } else if (!_records.biggestLoss || -net > _records.biggestLoss.amount) {
      _records.biggestLoss = who;
    }
  }

  // Everything below attributes to the hand's WINNER — find the top
  // current-player winner (skip the hand for these if none is current).
  const nickById = new Map(players.map(p => [p.playerId, p.nickname || p.playerId]));
  let win = null;
  for (const w of h.winners || []) {
    if (!_isCurrent(w.playerId)) continue;
    if (!win || (w.amount || 0) > win.amount) {
      win = { playerId: w.playerId, nick: nickById.get(w.playerId) || w.playerId, amount: w.amount || 0 };
    }
  }
  if (!win) return;
  const winnerHole = (players.find(p => p.playerId === win.playerId) || {}).hole;

  // 2) Biggest POT (everyone's chips committed).
  const pot = players.reduce((s, p) => s + (p.totalIn || 0), 0);
  if (pot > 0 && (!_records.biggestPot || pot > _records.biggestPot.amount)) {
    _records.biggestPot = { nick: win.nick, amount: pot, ts };
  }

  // 3) Longest WAR (raises + all-ins in the action log).
  let raises = 0;
  for (const e of h.events || []) {
    if (e && e.type === 'action' && (e.action === 'raise' || e.action === 'allin')) raises++;
  }
  if (raises > 0 && (!_records.longestWar || raises > _records.longestWar.count)) {
    _records.longestWar = { nick: win.nick, count: raises, ts };
  }

  // 4) Biggest BLUFF — pot won UNCONTESTED (everyone else folded) with a weak
  //    hand. strengthOf < 0.40 ≈ junk; the bigger the stolen pot, the better.
  const live = players.filter(p => !p.folded);
  if (live.length === 1 && live[0].playerId === win.playerId && winnerHole && winnerHole.length === 2) {
    let str = 1;
    try { str = strengthOf(winnerHole, board); } catch (_) {}
    if (str < 0.40 && (!_records.biggestBluff || pot > _records.biggestBluff.amount)) {
      _records.biggestBluff = { nick: win.nick, amount: pot, ts };
    }
  }

  // 5) Ugliest WINNER — weakest made hand to win a CONTESTED showdown (river
  //    dealt, ≥2 players standing). pokersolver rank: lower = worse.
  if (board.length === 5 && live.length >= 2 && winnerHole && winnerHole.length === 2) {
    try {
      const solved = SolverHand.solve([...winnerHole, ...board]);
      const rank = solved && solved.rank;
      if (Number.isFinite(rank) && (!_records.ugliestWinner || rank < _records.ugliestWinner.rank)) {
        _records.ugliestWinner = { nick: win.nick, hand: solved.descr || 'a hand', rank, ts };
      }
    } catch (_) {}
  }
}

/** Snapshot of the all-time records, broadcast in Table.publicState(). */
function getRecords() {
  const out = {};
  for (const k of Object.keys(_records)) out[k] = _records[k] ? { ..._records[k] } : null;
  return out;
}

// Seed from the existing hand log once at boot (best-effort, sync — the file is
// small and this only runs at startup).
(function seedRecords() {
  try {
    if (!fs.existsSync(HAND_LOG)) return;
    for (const line of fs.readFileSync(HAND_LOG, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { _applyHandRecords(JSON.parse(line)); } catch (_) {}
    }
  } catch (_) { /* best-effort */ }
})();

function logBotDecision({ tableId, playerId, mode, baseMode, decision, context }) {
  const row = {
    ts: new Date().toISOString(),
    table: tableId,
    bot: playerId,
    mode,
    baseMode,
    handStrength: context.strength,
    state: context.state,
    boardLen: context.boardLen,
    pot: context.pot,
    toCall: context.toCall,
    stack: context.stack,
    currentBet: context.currentBet,
    invested: context.invested,
    action: decision.action,
    amount: decision.amount,
    reason: decision.reason,
  };
  appendLine(BOT_LOG, row);
}

/** Append one chat-funnel line to conversation.jsonl. Receives the entry
 *  object Table.chat() builds ({ id, ts(ms), kind, text }) plus the
 *  optional `extras` (which may carry 11labs audio). Conversational lines
 *  are broadcast as "💬 Speaker: message"; we split the speaker out for
 *  easy filtering, while gameplay-narration kinds (action/win/hand/…)
 *  just log their text with speaker = null. `hasAudio` records whether a
 *  voice clip rode along, without bloating the log with the audio bytes. */
function logChat({ tableId, entry, extras }) {
  let speaker = null;
  let message = entry.text;
  const m = /^💬\s*([^:]+):\s*([\s\S]*)$/.exec(entry.text || '');
  if (m) { speaker = m[1].trim(); message = m[2]; }
  const row = {
    ts: new Date(entry.ts || Date.now()).toISOString(),
    tsMs: entry.ts,
    table: tableId,
    id: entry.id,
    kind: entry.kind,
    speaker,
    text: message,
    hasAudio: !!(extras && (extras.audio || extras.audioUrl)),
  };
  appendLine(CHAT_LOG, row);
}

module.exports = { logHand, logBotDecision, logChat, getRecords, HAND_LOG, BOT_LOG, CHAT_LOG, LOG_DIR };
