/**
 * Append-only JSONL loggers for offline analysis.
 *   - hands.jsonl         — one row per completed hand (board, players, actions, winners)
 *   - bot-decisions.jsonl — one row per bot decision (context + chosen action + reason)
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

module.exports = { logHand, logBotDecision, HAND_LOG, BOT_LOG, LOG_DIR };
