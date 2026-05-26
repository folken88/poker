/**
 * SQLite wrapper + roster seeding.
 *
 * Identity model (v0.2 prototype):
 *  - A fixed roster of 14 players is seeded on boot.
 *  - Each socket connection picks a player from the roster.
 *  - Chip totals are persistent per player_id (lowercased name).
 *  - No auth — anyone clicking "Fred" is Fred for that browser tab.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_PATH  = process.env.DB_PATH  || path.join(DATA_DIR, 'poker.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Schema
const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schemaSql);

// Idempotent column additions (SQLite doesn't support IF NOT EXISTS on ALTER).
function ensureColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}
ensureColumn('players', 'is_bot',     'INTEGER NOT NULL DEFAULT 0');
ensureColumn('players', 'bot_mode',   'TEXT');
// Long-term "tab" — every time a human hits Re-buy we add DEFAULT_STACK to
// this debt. They can pay it down later from their stack via `lobby:payDebt`.
// Bots do NOT accrue debt — their auto-rebuys are free (they're the house).
ensureColumn('players', 'rebuy_debt', 'INTEGER NOT NULL DEFAULT 0');

// ---- Roster (the fixed test players) ----
// 14 names, 12 avatars — two avatars get reused on purpose.
const ROSTER = [
  { name: 'Tobis',     avatar: 'dragon'  },
  { name: 'Fred',      avatar: 'fox'     },
  { name: 'Timmay',    avatar: 'robot'   },
  { name: 'LEEESA',    avatar: 'wizard'  },
  { name: 'Banana',    avatar: 'frog'    },
  { name: 'Sydness',   avatar: 'owl'     },
  { name: 'BRION',     avatar: 'knight'  },
  { name: 'Chrees',    avatar: 'bear'    },
  { name: 'Lowgan',    avatar: 'wolf'    },
  { name: 'Zachariah', avatar: 'lion'    },
  { name: 'Harry',     avatar: 'raccoon' },
  { name: 'Farts',     avatar: 'cat'     },
  { name: 'Butt',      avatar: 'wizard'  },
  { name: 'Boobs',     avatar: 'robot'   },
  { name: 'Cram',      avatar: 'bear'    },
];

// AI players — pre-seeded, available via "Add bot" button. Personality
// = baseMode. Bots impersonate notable Cassbot-vault PCs whose tokens were
// imported permanently into public/assets/characters/ (see
// scripts/import-vault-tokens.js + manifest.json). The game does NOT depend
// on the live Foundry character art mount.
const BOT_ROSTER = [
  // Cautious — careful clerics / tacticians
  { name: 'Dinvaya',              avatar: '/assets/characters/dinvaya.webp',              baseMode: 'cautious' },
  { name: 'Vaughan',              avatar: '/assets/characters/vaughan.webp',              baseMode: 'cautious' },
  // Standard — steady frontline / calculating
  { name: 'Storgrim Thunderbeard', avatar: '/assets/characters/storgrim-thunderbeard.webp', baseMode: 'standard' },
  { name: 'Kate Blackwood',        avatar: '/assets/characters/kate-blackwood.webp',        baseMode: 'standard' },
  // Risky — chaotic / bold
  { name: 'Kovira',               avatar: '/assets/characters/kovira.webp',               baseMode: 'risky'    },
  { name: 'Elfrip',               avatar: '/assets/characters/elfrip.webp',               baseMode: 'risky'    },
];

const DEFAULT_STACK = parseInt(process.env.DEFAULT_STACK || '5000', 10);

const stmts = {
  getPlayer:    db.prepare('SELECT * FROM players WHERE player_id = ?'),
  listPlayers:  db.prepare('SELECT * FROM players ORDER BY nickname COLLATE NOCASE'),
  listHumans:   db.prepare('SELECT * FROM players WHERE is_bot = 0 ORDER BY nickname COLLATE NOCASE'),
  listBots:     db.prepare('SELECT * FROM players WHERE is_bot = 1 ORDER BY nickname COLLATE NOCASE'),
  seedPlayer:   db.prepare(`
    INSERT OR IGNORE INTO players
      (player_id, nickname, avatar_id, chips, created_at, last_seen_at, is_bot, bot_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  touchPlayer:  db.prepare('UPDATE players SET last_seen_at = ? WHERE player_id = ?'),
  updateChips:  db.prepare('UPDATE players SET chips = ?, last_seen_at = ? WHERE player_id = ?'),
  addDebt:      db.prepare('UPDATE players SET rebuy_debt = rebuy_debt + ? WHERE player_id = ?'),
  payDebt:      db.prepare('UPDATE players SET chips = chips - ?, rebuy_debt = rebuy_debt - ? WHERE player_id = ?'),
  recordWin:    db.prepare('UPDATE players SET total_won = total_won + ?, hands_played = hands_played + 1 WHERE player_id = ?'),
  recordLoss:   db.prepare('UPDATE players SET total_lost = total_lost + ?, hands_played = hands_played + 1 WHERE player_id = ?'),
  insertHand:   db.prepare(`
    INSERT INTO hand_history (table_id, played_at, board, players_json, winners_json)
    VALUES (?, ?, ?, ?, ?)
  `),
  recentHands:  db.prepare('SELECT * FROM hand_history WHERE table_id = ? ORDER BY played_at DESC LIMIT ?'),
};

function seedRoster() {
  const now = Date.now();
  let humans = 0, bots = 0, prunedBots = 0;
  const updateBotAvatar = db.prepare('UPDATE players SET avatar_id = ? WHERE player_id = ? AND is_bot = 1');
  const deleteBot       = db.prepare('DELETE FROM players WHERE player_id = ? AND is_bot = 1');
  const listBotIds      = db.prepare('SELECT player_id FROM players WHERE is_bot = 1');

  const tx = db.transaction(() => {
    for (const p of ROSTER) {
      const id = p.name.toLowerCase();
      const r = stmts.seedPlayer.run(id, p.name, p.avatar, DEFAULT_STACK, now, now, 0, null);
      if (r.changes) humans++;
    }
    const currentBotIds = new Set();
    for (const p of BOT_ROSTER) {
      const id = p.name.toLowerCase();
      currentBotIds.add(id);
      const r = stmts.seedPlayer.run(id, p.name, p.avatar, DEFAULT_STACK, now, now, 1, p.baseMode);
      if (r.changes) bots++;
      // Always sync the avatar URL — handles migrations from old paths
      // (e.g. /foundry-art/... → /assets/characters/...).
      updateBotAvatar.run(p.avatar, id);
    }
    // Prune stale bot rows from previous rosters so they don't show up in
    // the "+ Bot" picker. Humans are never pruned (their chip totals matter).
    for (const row of listBotIds.all()) {
      if (!currentBotIds.has(row.player_id)) {
        deleteBot.run(row.player_id);
        prunedBots++;
      }
    }
  });
  tx();
  console.log(`[poker] seeded: humans=${humans}/${ROSTER.length} bots=${bots}/${BOT_ROSTER.length} pruned=${prunedBots} stale bots`);
}
seedRoster();

// ---- API used by sockets / game ----
function getPlayer(playerId) {
  return stmts.getPlayer.get(playerId);
}
function listPlayers() {
  return stmts.listPlayers.all();
}
function listHumans() { return stmts.listHumans.all(); }
function listBots()   { return stmts.listBots.all();   }
function touchPlayer(playerId) {
  stmts.touchPlayer.run(Date.now(), playerId);
}
function setChips(playerId, chips) {
  stmts.updateChips.run(chips, Date.now(), playerId);
}
function addRebuyDebt(playerId, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  stmts.addDebt.run(amount, playerId);
}
/** Take `amount` from chips and reduce debt by the same. Caller must
 *  pre-validate (amount > 0, amount <= chips, amount <= rebuy_debt). */
function payRebuyDebt(playerId, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  stmts.payDebt.run(amount, amount, playerId);
}
function recordWin(playerId, amount)  { stmts.recordWin.run(amount, playerId); }
function recordLoss(playerId, amount) { stmts.recordLoss.run(amount, playerId); }
function insertHand({ tableId, board, players, winners }) {
  stmts.insertHand.run(
    tableId,
    Date.now(),
    board,
    JSON.stringify(players),
    JSON.stringify(winners),
  );
}
function recentHands(tableId, limit = 50) {
  return stmts.recentHands.all(tableId, limit);
}

module.exports = {
  db,
  ROSTER,
  BOT_ROSTER,
  DEFAULT_STACK,
  getPlayer,
  listPlayers,
  listHumans,
  listBots,
  touchPlayer,
  setChips,
  addRebuyDebt,
  payRebuyDebt,
  recordWin,
  recordLoss,
  insertHand,
  recentHands,
};
