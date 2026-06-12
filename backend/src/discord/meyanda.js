/**
 * MEYANDA — the family Discord herald (android cleric, keeper of records).
 *
 * Two jobs, both read-only over the game's append-only logs:
 *   1. HAND LINES — Table.js calls onHandLogged() after every completed hand;
 *      when 2+ of the dealt-in seats were HUMAN-DRIVEN (a human playing as
 *      themselves OR piloting a persona bot — `players[].bot === false` in
 *      hands.jsonl terms), she posts one plain-text line to the poker-log
 *      channel. A bot at the table (or winning) doesn't disqualify the hand:
 *      the rule is two PEOPLE playing, not two people winning.
 *   2. DAILY REPORT — at 11:00 America/Chicago (6–7am for Fred in Hawaii) she
 *      posts a stat breakdown of the last day's HUMAN-INVOLVED hands (≥1
 *      human-driven seat) plus a dungeon line, read from hands.jsonl and
 *      dungeon.jsonl.
 *
 * Config lives OUTSIDE git in the bind-mounted data dir (gitignored):
 *   /app/data/.meyanda.env
 *     MEYANDA_ENABLED=1
 *     MEYANDA_TOKEN=<discord bot token — NEVER commit this>
 *     MEYANDA_CHANNEL=<channel id>
 * A missing or disabled file makes the whole module a silent no-op, so the
 * testbed (no env file) runs dark and a failed Discord call can never touch
 * the poker game — every entry point swallows its own errors.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const LOG_DIR  = process.env.LOG_DIR  || path.join(__dirname, '..', '..', 'logs');
const ENV_FILE = path.join(DATA_DIR, '.meyanda.env');
const HAND_LOG = path.join(LOG_DIR, 'hands.jsonl');
const DUNGEON_LOG = path.join(LOG_DIR, 'dungeon.jsonl');

const cfg = { enabled: false, token: null, channel: null };
function loadCfg() {
  cfg.enabled = false; cfg.token = null; cfg.channel = null;
  try {
    const txt = fs.readFileSync(ENV_FILE, 'utf8');
    for (const line of txt.split('\n')) {
      if (line.trim().startsWith('#')) continue;
      const m = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      if (m[1] === 'MEYANDA_ENABLED') cfg.enabled = m[2] === '1' || m[2] === 'true';
      else if (m[1] === 'MEYANDA_TOKEN') cfg.token = m[2];
      else if (m[1] === 'MEYANDA_CHANNEL') cfg.channel = m[2];
    }
  } catch (_) { /* no env file → stay disabled */ }
  if (!cfg.token || !cfg.channel) cfg.enabled = false;
  return cfg.enabled;
}

/** POST one message to the configured channel via the plain REST API (no
 *  gateway needed for write-only posting). Respects Discord's 2000-char cap;
 *  one polite retry on 429. Errors log and STOP here — never into the game. */
async function post(content) {
  if (!cfg.enabled) return false;
  const body = JSON.stringify({ content: String(content).slice(0, 1990) });
  const send = () => fetch(`https://discord.com/api/v10/channels/${cfg.channel}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bot ${cfg.token}`, 'Content-Type': 'application/json' },
    body,
  });
  let r = await send();
  if (r.status === 429) {
    const j = await r.json().catch(() => ({}));
    await new Promise(res => setTimeout(res, Math.ceil(((j && j.retry_after) || 1) * 1000)));
    r = await send();
  }
  if (!r.ok) { console.error('[meyanda] post failed:', r.status, await r.text().catch(() => '')); return false; }
  return true;
}

const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
const pretty = (c) => c ? String(c).slice(0, -1) + (SUIT[String(c).slice(-1).toUpperCase()] || String(c).slice(-1)) : '';

/** One line per completed hand with 2+ human-driven dealt-in seats. */
function onHandLogged({ hand, botByPlayer }) {
  try {
    if (!cfg.enabled || !hand) return;
    const dealt = hand.players || [];
    const humanIds = new Set(Object.entries(botByPlayer || {}).filter(([, isBot]) => isBot === false).map(([id]) => id));
    if (dealt.filter(p => humanIds.has(p.playerId)).length < 2) return;
    const winners = hand.winners || [];
    const pot = winners.reduce((s, w) => s + (w.amount || 0), 0);
    const names = [...new Set(winners.map(w => (dealt.find(p => p.playerId === w.playerId) || {}).nickname || w.playerId))];
    const desc = (winners.find(w => w.handDesc) || {}).handDesc;
    const board = (hand.board || []).map(pretty).join(' ');
    const roster = dealt.map(p => p.nickname + (humanIds.has(p.playerId) ? '' : ' (AI)')).join(', ');
    const line = `♠ ${names.join(' & ')} ${names.length > 1 ? 'split' : 'wins'} ${pot.toLocaleString()} gp` +
      (desc ? ` — ${desc}` : ' — everyone folded') +
      (board ? ` · board ${board}` : '') +
      ` · in the hand: ${roster}`;
    post(line).catch(e => console.error('[meyanda]', e.message));
  } catch (e) { console.error('[meyanda]', e.message); }
}

/** Human debt events for the poker log — a borrow from, or a repayment to,
 *  the First Bank of Abadar. Callers gate on !is_bot (human ledger only). */
function onDebtEvent({ nickname, kind, amount, debtNow }) {
  try {
    if (!cfg.enabled) return;
    const line = kind === 'borrow'
      ? `🏦 ${nickname} borrowed ${gp(amount)} from the Bank of Abadar — debt now ${gp(debtNow)}.`
      : (debtNow > 0
        ? `💸 ${nickname} paid ${gp(amount)} toward their tab — ${gp(debtNow)} still owed.`
        : `✅ ${nickname} settled their debt in full (${gp(amount)} paid). The ledger smiles.`);
    post(line).catch(e => console.error('[meyanda]', e.message));
  } catch (e) { console.error('[meyanda]', e.message); }
}

function readJsonl(file, sinceMs) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(r => r && (!sinceMs || (Date.parse(r.ts) || 0) >= sinceMs));
  } catch (_) { return []; }
}

const gp = (n) => `${Math.round(n).toLocaleString()} gp`;
const signedGp = (n) => `${n >= 0 ? '+' : '−'}${gp(Math.abs(n))}`;
const chiDate = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric' }).format(d);

/** Net gp per human-driven player across a set of hand rows → ranked array. */
function humanNets(rows) {
  const net = new Map();
  for (const r of rows) for (const p of (r.players || [])) {
    if (p.bot !== false) continue;   // human-driven seats only
    const won = (r.winners || []).filter(w => w.playerId === p.playerId).reduce((s, w) => s + (w.amount || 0), 0);
    const e = net.get(p.playerId) || { nick: p.nickname, net: 0, hands: 0 };
    e.net += won - (p.totalIn || 0); e.hands++; e.nick = p.nickname;
    net.set(p.playerId, e);
  }
  return [...net.values()].sort((a, b) => b.net - a.net);
}

/** The 11am stat breakdown. Hand stats default to HUMAN-INVOLVED hands (≥1
 *  human-driven seat). A quiet day (no human hands in 24h) swaps the daily
 *  section for a HISTORICAL one from the full archive. Every report carries
 *  current standings (leaders & losers) + all-time Hall of Records lines. */
function dailyReport() {
  const since = Date.now() - 24 * 3600 * 1000;
  const allRows = readJsonl(HAND_LOG);                                          // full archive, one read
  const humanRows = allRows.filter(r => (r.players || []).some(p => p.bot === false));
  const rows24 = allRows.filter(r => (Date.parse(r.ts) || 0) >= since);
  const hands24 = rows24.filter(r => (r.players || []).some(p => p.bot === false));
  const lines = [`📊 Daily poker report — ${chiDate(new Date())}`];

  if (hands24.length) {
    // ── The last day's action ──
    lines.push(`Hands with humans: ${hands24.length}${rows24.length > hands24.length ? ` (the bots played ${rows24.length - hands24.length} more on their own)` : ''}`);
    let big = null;
    for (const r of hands24) { const pot = (r.winners || []).reduce((s, w) => s + (w.amount || 0), 0); if (!big || pot > big.pot) big = { pot, r }; }
    if (big && big.pot > 0) {
      const w = big.r.winners[0] || {};
      const nick = ((big.r.players || []).find(p => p.playerId === w.playerId) || {}).nickname || w.playerId;
      lines.push(`Biggest pot today: ${gp(big.pot)} — ${nick}${w.handDesc ? ` (${w.handDesc})` : ''}`);
    }
    const ranked = humanNets(hands24).slice(0, 6);
    if (ranked.length) lines.push('Today: ' + ranked.map(e => `${e.nick} ${signedGp(e.net)} over ${e.hands} hands`).join(' · '));
  } else {
    // ── Quiet day → report from the archives instead ──
    lines.push('A quiet day — no human hands since yesterday. From the archives instead:');
    const last = humanRows[humanRows.length - 1];
    if (last) {
      const w = (last.winners || [])[0] || {};
      const nick = ((last.players || []).find(p => p.playerId === w.playerId) || {}).nickname || w.playerId;
      lines.push(`Last human action: ${chiDate(new Date(Date.parse(last.ts)))} — ${nick} took ${gp((last.winners || []).reduce((s, x) => s + (x.amount || 0), 0))}${w.handDesc ? ` (${w.handDesc})` : ''}.`);
    }
    if (humanRows.length) {
      const firstTs = Date.parse(humanRows[0].ts);
      lines.push(`All-time: ${humanRows.length.toLocaleString()} human hands logged since ${chiDate(new Date(firstTs))}.`);
      const career = humanNets(humanRows);
      const tops = career.slice(0, 3), bottoms = career.slice(-2).filter(e => !tops.includes(e) && e.net < 0);
      if (career.length) lines.push('Career (full log): ' + [...tops, ...bottoms].map(e => `${e.nick} ${signedGp(e.net)}`).join(' · '));
    }
  }

  // ── Standings — PURE POKER (won − lost), same metric as the leaderboards.
  //    Cash and magic items are deliberately NOT a factor: the table is Fred's
  //    game and the dungeon is Josh's — dungeon hauls don't move this board.
  try {
    const db = require('../persistence/db');
    const everyone = db.listAll() || [];
    const played = (p) => (p.pokerHands || 0) > 0;
    const humans = everyone.filter(p => !p.is_bot && played(p)).sort((a, b) => (b.pokerNet || 0) - (a.pokerNet || 0));
    if (humans.length) {
      const tops = humans.slice(0, 3).map(p => `${p.nickname} ${signedGp(p.pokerNet || 0)}`).join(' · ');
      const ai = everyone.filter(p => p.is_bot && played(p)).sort((a, b) => (b.pokerNet || 0) - (a.pokerNet || 0))[0];
      lines.push(`💰 Poker standings (won − lost): ${tops}${ai ? ` — top AI: ${ai.nickname} ${signedGp(ai.pokerNet || 0)}` : ''}`);
      const debtors = everyone.filter(p => !p.is_bot && (p.rebuy_debt || 0) > 0).sort((a, b) => (b.rebuy_debt || 0) - (a.rebuy_debt || 0)).slice(0, 3);
      if (debtors.length) lines.push('📉 In the red: ' + debtors.map(p => `${p.nickname} owes ${gp(p.rebuy_debt)} (${gp(p.chips || 0)} on hand)`).join(' · '));
    }
  } catch (e) { console.error('[meyanda] standings:', e.message); }

  // ── All-time Hall of Records (logger seeds these from the full log at boot) ──
  try {
    const { getRecords } = require('../persistence/logger');
    const r = (getRecords() || {}).all || {};
    const bits = [];
    if (r.biggestPot)    bits.push(`biggest pot ${gp(r.biggestPot.amount)} (${r.biggestPot.nick})`);
    if (r.biggestWin)    bits.push(`biggest single-hand heater ${gp(r.biggestWin.amount)} (${r.biggestWin.nick})`);
    if (r.biggestBluff)  bits.push(`biggest bluff ${gp(r.biggestBluff.amount)} (${r.biggestBluff.nick})`);
    if (r.ugliestWinner) bits.push(`ugliest winner: ${r.ugliestWinner.nick} with ${r.ugliestWinner.hand}`);
    if (r.longestWar)    bits.push(`longest war ${r.longestWar.count} raises (${r.longestWar.nick})`);
    if (bits.length) lines.push('🏆 All-time: ' + bits.join(' · '));
  } catch (e) { console.error('[meyanda] records:', e.message); }

  // ── Dungeon line: last day if there was action, else all-time ──
  const dunAll = readJsonl(DUNGEON_LOG);
  const dun24 = dunAll.filter(r => (Date.parse(r.ts) || 0) >= since);
  const dunRows = dun24.length ? dun24 : dunAll;
  const clears = dunRows.filter(r => r.type === 'clear').length;
  const deepest = dunRows.reduce((mx, r) => Math.max(mx, r.depth || 0), 0);
  const ups = dunRows.filter(r => r.type === 'levelup').length;
  if (clears || ups) lines.push(`Dungeon${dun24.length ? '' : ' (all-time)'}: ${clears} room${clears === 1 ? '' : 's'} cleared, deepest depth ${deepest}, ${ups} level-up${ups === 1 ? '' : 's'}.`);

  lines.push('— Meyanda, keeper of records');
  return lines.join('\n');
}

/** ms until the next 11:00 in America/Chicago. Recomputed at every arm, so DST
 *  shifts self-correct within one cycle. */
function msUntilChicago11() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const sec = (parseInt(parts.hour, 10) % 24) * 3600 + parseInt(parts.minute, 10) * 60 + parseInt(parts.second, 10);
  let delta = 11 * 3600 - sec;
  if (delta <= 0) delta += 24 * 3600;
  return delta * 1000;
}

let _dailyTimer = null;
function armDaily() {
  clearTimeout(_dailyTimer);
  _dailyTimer = setTimeout(async () => {
    try { await post(dailyReport()); } catch (e) { console.error('[meyanda] daily:', e.message); }
    armDaily();
  }, msUntilChicago11());
  if (_dailyTimer.unref) _dailyTimer.unref();   // never hold the process open
}

function start() {
  if (!loadCfg()) { console.log('[meyanda] disabled (no data/.meyanda.env, or MEYANDA_ENABLED != 1)'); return; }
  console.log(`[meyanda] enabled — posting to channel ${cfg.channel}; daily report at 11:00 America/Chicago (in ${Math.round(msUntilChicago11() / 60000)} min)`);
  armDaily();
}

module.exports = { start, onHandLogged, onDebtEvent, dailyReport, post, loadCfg };
