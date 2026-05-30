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
}

function winningsFor(winners, playerId) {
  return winners.filter(w => w.playerId === playerId).reduce((s, w) => s + w.amount, 0);
}

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

module.exports = { logHand, logBotDecision, logChat, HAND_LOG, BOT_LOG, CHAT_LOG, LOG_DIR };
