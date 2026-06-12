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
const DUNGEON_LOG = path.join(LOG_DIR, 'dungeon.jsonl');
// Blind-mode accessibility telemetry — one row per client log entry, streamed
// up from allow-listed blind testers (e.g. Josh) so we can read their session
// without asking a blind user to copy their browser console.
const BLIND_LOG = path.join(LOG_DIR, 'blind.jsonl');

function appendLine(file, obj) {
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch (e) {
    console.error('[logger]', file, e.message);
  }
}

/** Append one blind-mode telemetry row (server timestamp + player + message). */
function logBlind(row) { appendLine(BLIND_LOG, row); }

function logHand({ tableId, hand, durationMs, botByPlayer = {} }) {
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
      // AI-driven (true) or a HUMAN who took over the character (false) this hand;
      // null = unknown. Lets offline analysis judge a bot without counting a
      // human's hands against it.
      bot:        (p.playerId in botByPlayer) ? botByPlayer[p.playerId] : null,
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
//   biggestWin      : most chips a player NET gained in one hand ("Gain" —
//                     profit after their own contribution; cf. biggestPot)
//   biggestLoss     : most chips a player NET lost in one hand
//   biggestPot      : largest total pot fought over (attributed to its winner)
//   longestWar      : most raises/all-ins in one hand (a betting slugfest)
//   biggestBluff    : biggest pot stolen uncontested with a weak hand
//   ugliestWinner   : weakest made hand to win a shown-down pot
// Records are tracked per POPULATION so the Hall of Records can be filtered:
//   all    — best across everyone
//   human  — best among human players
//   ai      — best among the AI
const _emptyRecs = () => ({ biggestWin: null, biggestLoss: null, biggestPot: null, longestWar: null, biggestBluff: null, ugliestWinner: null });
const _recAll = _emptyRecs(), _recHuman = _emptyRecs(), _recAi = _emptyRecs();
// ── Career poker NET (won − lost) per player ────────────────────────────────
// Accumulated alongside the records (same boot seed, same reset-era markers)
// and handed to db ONCE by reference — db decorates roster rows with
// pokerNet/pokerHands so the leaderboards rank by RESULTS, not current cash.
const _nets = new Map();
try { db.setPokerNets(_nets); } catch (_) { /* db without the hook (old build) */ }
const _isBotPid = (pid) => { try { return !!(db.getPlayer(String(pid || '')) || {}).is_bot; } catch (_) { return false; } };
// Set a category's record on the "all" store AND the holder's population store,
// using a `better(existing, candidate) → bool` comparator.
function _bumpRec(cat, cand, better, isBot) {
  if (!_recAll[cat] || better(_recAll[cat], cand)) _recAll[cat] = cand;
  const store = isBot ? _recAi : _recHuman;
  if (!store[cat] || better(store[cat], cand)) store[cat] = cand;
}

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

  const nickById = new Map(players.map(p => [p.playerId, p.nickname || p.playerId]));

  // 0) Career NET: every dealt-in current player banks (winnings − contribution)
  //    for this hand — the leaderboard metric. Counts zero-net hands too (the
  //    hands counter is how the boards hide never-played players).
  for (const p of players) {
    if (!_isCurrent(p.playerId)) continue;
    const delta = (p.stackEnd || 0) - (p.stackStart || 0);
    const acc = _nets.get(p.playerId) || { net: 0, hands: 0 };
    acc.net += Number.isFinite(delta) ? delta : 0;
    acc.hands += 1;
    _nets.set(p.playerId, acc);
  }

  // 1) Biggest single-hand GAIN / LOSS — most chips a current player NET
  //    gained / lost in one hand (stack delta, i.e. after subtracting their
  //    own contribution). "Gain" is profit, distinct from the gross "Pot".
  for (const p of players) {
    if (!_isCurrent(p.playerId)) continue;
    const net = (p.stackEnd || 0) - (p.stackStart || 0);
    if (!Number.isFinite(net) || net === 0) continue;
    const isBot = _isBotPid(p.playerId);
    const who = { nick: p.nickname || p.playerId, amount: Math.abs(net), ts };
    if (net > 0) _bumpRec('biggestWin', who, (a, c) => c.amount > a.amount, isBot);
    else _bumpRec('biggestLoss', who, (a, c) => c.amount > a.amount, isBot);
  }

  // Everything below attributes to the hand's WINNER — find the top
  // current-player winner (skip the hand for these if none is current).
  let win = null;
  for (const w of h.winners || []) {
    if (!_isCurrent(w.playerId)) continue;
    if (!win || (w.amount || 0) > win.amount) {
      win = { playerId: w.playerId, nick: nickById.get(w.playerId) || w.playerId, amount: w.amount || 0 };
    }
  }
  if (!win) return;
  const isBotWin = _isBotPid(win.playerId);
  const winnerHole = (players.find(p => p.playerId === win.playerId) || {}).hole;

  // 2) Biggest POT (everyone's chips committed).
  const pot = players.reduce((s, p) => s + (p.totalIn || 0), 0);
  if (pot > 0) _bumpRec('biggestPot', { nick: win.nick, amount: pot, ts }, (a, c) => c.amount > a.amount, isBotWin);

  // 3) Longest WAR (raises + all-ins in the action log).
  let raises = 0;
  for (const e of h.events || []) {
    if (e && e.type === 'action' && (e.action === 'raise' || e.action === 'allin')) raises++;
  }
  if (raises > 0) _bumpRec('longestWar', { nick: win.nick, count: raises, ts }, (a, c) => c.count > a.count, isBotWin);

  // 4) Biggest BLUFF — pot won UNCONTESTED (everyone else folded) with a weak
  //    hand. strengthOf < 0.40 ≈ junk; the bigger the stolen pot, the better.
  const live = players.filter(p => !p.folded);
  if (live.length === 1 && live[0].playerId === win.playerId && winnerHole && winnerHole.length === 2) {
    let str = 1;
    try { str = strengthOf(winnerHole, board); } catch (_) {}
    if (str < 0.40) _bumpRec('biggestBluff', { nick: win.nick, amount: pot, ts }, (a, c) => c.amount > a.amount, isBotWin);
  }

  // 5) Ugliest WINNER — weakest made hand to win a CONTESTED showdown (river
  //    dealt, ≥2 players standing). pokersolver rank: lower = worse.
  if (board.length === 5 && live.length >= 2 && winnerHole && winnerHole.length === 2) {
    try {
      const solved = SolverHand.solve([...winnerHole, ...board]);
      const rank = solved && solved.rank;
      if (Number.isFinite(rank)) _bumpRec('ugliestWinner', { nick: win.nick, hand: solved.descr || 'a hand', rank, ts }, (a, c) => c.rank < a.rank, isBotWin);
    } catch (_) {}
  }
}

/** Snapshot of the records by population (only counts hands since last reset).
 *  Returns { all, human, ai }, each a map of category → record | null. */
function getRecords() {
  const clone = (store) => { const o = {}; for (const k of Object.keys(store)) o[k] = store[k] ? { ...store[k] } : null; return o; };
  return { all: clone(_recAll), human: clone(_recHuman), ai: clone(_recAi) };
}

function _clearRecords() { for (const store of [_recAll, _recHuman, _recAi]) for (const k of Object.keys(store)) store[k] = null; _nets.clear(); }

/** Start a fresh records era. Called on a Full Reset / Loot Lord win: wipes the
 *  current records AND writes a boundary marker to the hand log, so the board
 *  only ever counts hands AFTER the most recent big reset — even across restarts
 *  (the seed below clears its accumulator whenever it hits a marker). */
function resetRecords() {
  _clearRecords();
  appendLine(HAND_LOG, { type: 'reset', ts: new Date().toISOString() });
}

// Seed from the hand log once at boot (best-effort, sync — small file). A
// `{type:'reset'}` marker line clears the accumulator, so only hands after the
// last reset survive.
(function seedRecords() {
  try {
    if (!fs.existsSync(HAND_LOG)) return;
    for (const line of fs.readFileSync(HAND_LOG, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const h = JSON.parse(line);
        if (h && h.type === 'reset') { _clearRecords(); continue; }
        _applyHandRecords(h);
      } catch (_) {}
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

/** Append one dungeon event to dungeon.jsonl (run start/room/action/clear/
 *  loot/bail/death). Timestamped; for offline troubleshooting + tuning. */
function logDungeon(event) {
  appendLine(DUNGEON_LOG, { ts: new Date().toISOString(), ...event });
}

// ── Recent-sounds ring buffer ───────────────────────────────────────────────
// In-memory log of the last sounds emitted to clients (dungeon combat + table
// banter/fight audio), for diagnosing "what's getting overplayed". Tallies a
// play-count per sound so a repeat offender is obvious. Exposed via GET /api/sounds.
const _recentSounds = [];
function recordSound(source, sound, label) {
  if (!sound) return;
  _recentSounds.push({ ts: Date.now(), source, sound, label: (label || '').slice(0, 80) });
  if (_recentSounds.length > 60) _recentSounds.shift();
}
/** The last `n` sounds (newest last) plus a play-count tally over the buffer. */
function recentSounds(n = 10) {
  const last = _recentSounds.slice(-n).map(s => ({ ...s }));
  const counts = {};
  for (const s of _recentSounds) counts[s.sound] = (counts[s.sound] || 0) + 1;
  const tally = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([sound, count]) => ({ sound, count }));
  return { last, tally, bufferSize: _recentSounds.length };
}

module.exports = { logHand, logBotDecision, logChat, logDungeon, logBlind, getRecords, resetRecords, recordSound, recentSounds, HAND_LOG, BOT_LOG, CHAT_LOG, DUNGEON_LOG, BLIND_LOG, LOG_DIR };
