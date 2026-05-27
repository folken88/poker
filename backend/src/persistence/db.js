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
// Bot intelligence: 'low' | 'average' | 'high'. Adds noise to the
// strength estimate inside Bot.decide() — low-int bots mis-read hands
// more often, high-int bots are nearly always right. Independent of
// bot_mode (risk appetite).
ensureColumn('players', 'bot_intelligence', "TEXT NOT NULL DEFAULT 'average'");
// Long-term "tab" — every time a human hits Re-buy we add DEFAULT_STACK to
// this debt. They can pay it down later from their stack via `lobby:payDebt`.
// Bots do NOT accrue debt — their auto-rebuys are free (they're the house).
ensureColumn('players', 'rebuy_debt', 'INTEGER NOT NULL DEFAULT 0');
// JSON object mapping sword tier (string '1'..'5') to count, e.g.
// '{"1":2,"2":1}' = two +1 longswords and one +2. LEGACY — superseded by
// the `gear` column below. Left in place so older rows don't break.
ensureColumn('players', 'swords',     "TEXT NOT NULL DEFAULT '{}'");
// JSON object: { weapon: 5, armor: null, shield: 3, ring: null, cloak: 4 }.
// (Amulet slot removed 2026-05; see migrateRemoveAmulet below.)
// One slot per gear type, value = enhancement tier (1–5) or null/absent.
// Players keep one item per slot. Goal: +5 in all five = LOOT LORD.
ensureColumn('players', 'gear',       "TEXT NOT NULL DEFAULT '{}'");

// Champions Board — one row per Loot Lord. Logged when someone hits +5
// in every slot. The reset-to-default that follows wipes everyone's
// chips/gear but this table records the historical winners forever.
db.exec(`
  CREATE TABLE IF NOT EXISTS champions (
    id INTEGER PRIMARY KEY,
    player_id TEXT NOT NULL,
    nickname  TEXT NOT NULL,
    avatar_id TEXT,
    won_at    INTEGER NOT NULL,
    hands_to_win INTEGER,
    final_chips  INTEGER
  );
`);

// ---- Reserved human roster ----
// EVERY entry here is a RESERVED HUMAN identity — saved for real
// people the user plays with. The "+ Bot" button (lobby:addBot) never
// picks from this list; the AI driver (_maybeDriveBot in Table.js)
// only acts on seats where seat.isBot === true, which itself comes
// from player.is_bot = 1. Reserved humans always seed with is_bot = 0,
// so AI cannot drive or supersede them. Their chips, gear, and rebuy
// debt persist across sessions for whoever sits down as them.
// User explicitly named these as reserved: Tobis, Timmy (Timmay),
// Sydness, BRION, Zachariah, Harry, Banana, Fred, LEEESA — the rest
// (Chrees, Lowgan, Farts, Butt, Boobs, Cram) follow the same policy
// since they all live in this ROSTER as is_bot=0 humans.
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
  { name: 'Daemon',    avatar: 'wolf'    },
  { name: 'Kip',       avatar: 'fox'     },
  { name: 'Mandore',   avatar: 'knight'  },
  { name: 'Gramm',     avatar: 'lion'    },
  { name: 'Rique',     avatar: 'raccoon' },
];

// AI players — pre-seeded, available via "Add bot" button. Humans can
// also pick them from the roster to "supersede" the AI for a session.
// Personality = baseMode (cautious / standard / risky). Avatar paths
// point at /tokens/ files imported by scripts/import-token-gallery.js.
// `intelligence`: 'low' | 'average' | 'high' — affects how much noise
// is added to the bot's hand-strength estimate in Bot.decide(). High =
// nearly always right; low = frequently misreads. Independent from
// baseMode (risk appetite).
const BOT_ROSTER = [
  // Original 6 bots
  { name: 'Dinvaya',              avatar: '/tokens/dinvaya.webp',              baseMode: 'cautious', intelligence: 'high'    },
  { name: 'Vaughan',              avatar: '/tokens/vaughan.webp',              baseMode: 'risky',    intelligence: 'high'    }, // user: high intel + high risk
  { name: 'Storgrim Thunderbeard', nickname: 'Storgrim', avatar: '/tokens/storgrim-thunderbeard.webp', baseMode: 'cautious', intelligence: 'average' }, // user: avg intel + cautious
  { name: 'Kate Blackwood',        nickname: 'Kate',     avatar: '/tokens/kate-blackwood.webp',        baseMode: 'cautious', intelligence: 'high'    }, // user: high intel + low risk
  { name: 'Kovira',               avatar: '/tokens/kovira.webp',               baseMode: 'risky',    intelligence: 'high'    },
  { name: 'Elfrip',               avatar: '/tokens/elfrip.webp',               baseMode: 'standard', intelligence: 'low'     }, // user: goblin cleric, low intel + normal risk

  // Round 2 additions
  { name: 'Taelys',               avatar: '/tokens/taelys-of-starfall.webp',     baseMode: 'risky',    intelligence: 'low'     }, // user: low intel + high risk
  { name: 'Lirienne',             avatar: '/tokens/lirienne-voss.webp',          baseMode: 'standard', intelligence: 'average' }, // user: avg intel + normal risk
  { name: 'Kelda',                avatar: '/tokens/kelda-ironglim.webp',         baseMode: 'cautious', intelligence: 'high'    }, // user: cautious + high intel
  { name: 'Mr. Brow',             avatar: '/tokens/augustus-teabrow.webp',       baseMode: 'risky',    intelligence: 'high'    }, // user: highly intelligent + risky
  { name: 'Nomkath',              avatar: '/tokens/nomkath.webp',                baseMode: 'standard', intelligence: 'average' }, // user: avg intel + avg risk
  { name: 'Ulfred',               avatar: '/tokens/ulfred-stronginthearm.webp',  baseMode: 'standard', intelligence: 'average' },
  { name: 'Kai Ginn',             avatar: '/tokens/kai-gin.webp',                baseMode: 'standard', intelligence: 'average' }, // user: avg intel + avg risk
  { name: 'Crisp',                avatar: '/tokens/crisp.webp',                  baseMode: 'risky',    intelligence: 'low'     }, // velociraptor — pure instinct, no thinking
  { name: 'Tamsin',               avatar: '/tokens/tamsin.webp',                 baseMode: 'cautious', intelligence: 'high'    },
  { name: 'Toni',                 avatar: '/tokens/antoinette-borden.webp',      baseMode: 'risky',    intelligence: 'average' },
  { name: 'Agu',                  avatar: '/tokens/aguclandos-lem.webp',         baseMode: 'cautious', intelligence: 'high'    },

  // Round 3 additions
  { name: 'Fera',                 avatar: '/tokens/fera.webp',                   baseMode: 'cautious', intelligence: 'high'    }, // user: high intel + low risk
  { name: 'Gaspar',               avatar: '/tokens/gaspar.webp',                 baseMode: 'standard', intelligence: 'average' }, // user: avg intel + normal risk
  { name: 'Daramid',              avatar: '/tokens/daramid.webp',                baseMode: 'cautious', intelligence: 'high'    }, // user: high intel + cautious
  { name: 'Farrah',               avatar: '/tokens/farrah.webp',                 baseMode: 'standard', intelligence: 'low'     },
  { name: 'Concetta',             avatar: '/tokens/concetta.webp',               baseMode: 'risky',    intelligence: 'high'    }, // user: highly intelligent + risky
  { name: 'Rissa',                avatar: '/tokens/rissa.webp',                  baseMode: 'risky',    intelligence: 'average' }, // user: avg intel + risky
  { name: 'Conchobar',            avatar: '/tokens/conchobar.webp',              baseMode: 'risky',    intelligence: 'low'     }, // bard, pure vibes

  // Round 4 additions — user-specified with explicit intel + risk:
  { name: 'Tokala',               avatar: '/tokens/tokala.webp',                 baseMode: 'risky',    intelligence: 'low'     }, // user: high risk + low intel
  { name: 'Casandalee',           avatar: '/tokens/casandalee.webp',             baseMode: 'cautious', intelligence: 'high'    }, // user: low risk + high intel
  { name: 'Meyanda',              avatar: '/tokens/meyanda.webp',                baseMode: 'standard', intelligence: 'high'    }, // user: avg risk + high intel

  // Round 5 additions:
  { name: 'Rhyarca',              avatar: '/tokens/rhyarca-jillyr.webp',         baseMode: 'standard', intelligence: 'average' }, // user: normal risk + normal intel; Oracle of Besmara (drow art)

  // Round 6 additions — Carrion Crown villains + Caliphas NPCs + Chef:
  { name: 'Adimarus',             avatar: '/tokens/adimarus.webp',               baseMode: 'risky',    intelligence: 'high'    }, // Shudderwood werewolf antipaladin of Jezelda; user: high intel + high risk
  { name: 'Estovion',             avatar: '/tokens/estovion.webp',               baseMode: 'cautious', intelligence: 'high'    }, // Master of Ascanor Lodge; user: high intel + cautious
  { name: 'Auren Vrood',          avatar: '/tokens/auren-vrood.webp',            baseMode: 'standard', intelligence: 'high'    }, // Whispering Way necromancer; user: high intel + normal risk
  { name: 'Tar Baphon',           avatar: '/tokens/tar-baphon.webp',             baseMode: 'standard', intelligence: 'high'    }, // The Whispering Tyrant; user: high intel + normal risk
  { name: 'Farrus Richton',       avatar: '/tokens/farrus-richton.webp',         baseMode: 'risky',    intelligence: 'average' }, // The Butcher of Courtaud (Farrah's grandpa ghost); user: avg intel + high risk
  { name: 'Vesorianna',           avatar: '/tokens/vesorianna.webp',             baseMode: 'standard', intelligence: 'average' }, // Harrowstone warden's-wife ghost; user: avg intel + avg risk
  { name: 'Lou Candlebean',       avatar: '/tokens/lou-candlebean.webp',         baseMode: 'standard', intelligence: 'low'     }, // Caliphas gnome cavalier mercenary; user: low intel + avg risk
  { name: 'Elodie',               avatar: '/tokens/elodie.webp',                 baseMode: 'standard', intelligence: 'average' }, // Caliphas gnome bard / estoc-swashbuckler; user: avg intel + avg risk
  { name: 'Chef',                 avatar: '/tokens/chef.webp',                   baseMode: 'risky',    intelligence: 'high'    }, // Gordon-Ramsay-but-won't-admit-it; high-intensity host (user: not specified, picking risky/high)
];

const DEFAULT_STACK = parseInt(process.env.DEFAULT_STACK || '5000', 10);

// ============================================================
// PF1e GEAR ECONOMY
// ============================================================
// Five magic-item slots, each upgradeable from +1 to +5. Goal of the game:
// own a full +5 set across every slot. First player to do so is declared
// the LOOT LORD, wins, and gets logged on the Champions Board.
//
// PF1e standard prices = base item + masterwork + enhancement(bonus² × multiplier).
// Multipliers: weapon/ring ×2000, armor/shield/cloak ×1000.
// (5-slot game — amulet slot was removed to save space on seat cards.)
const GEAR_SLOTS = [
  { key: 'weapon', label: 'Longsword',           short: 'Weapon',  mw: 315,  multiplier: 2000 },
  { key: 'armor',  label: 'Full Plate',          short: 'Armor',   mw: 1650, multiplier: 1000 },
  { key: 'shield', label: 'Heavy Steel Shield',  short: 'Shield',  mw: 170,  multiplier: 1000 },
  { key: 'cloak',  label: 'Cloak of Resistance', short: 'Cloak',   mw: 0,    multiplier: 1000 },
  { key: 'ring',   label: 'Ring of Protection',  short: 'Ring',    mw: 0,    multiplier: 2000 },
];
const GEAR_SLOT_KEYS = GEAR_SLOTS.map(s => s.key);
const GEAR_BY_KEY = Object.fromEntries(GEAR_SLOTS.map(s => [s.key, s]));

/** Price (gp) for the given slot at the given enhancement tier (1–5). */
function gearPrice(slotKey, tier) {
  const s = GEAR_BY_KEY[slotKey];
  if (!s || tier < 1 || tier > 5) return 0;
  return s.mw + tier * tier * s.multiplier;
}

/** All tier prices for one slot, useful for the bank UI. */
function gearPriceTable(slotKey) {
  return [1, 2, 3, 4, 5].map(t => ({ tier: t, price: gearPrice(slotKey, t) }));
}

/** Half of the current item's market price, rounded down. PF1e standard
 *  resale rate. Returns 0 if the slot is empty. */
function gearHockValue(slotKey, currentTier) {
  if (!currentTier) return 0;
  return Math.floor(gearPrice(slotKey, currentTier) / 2);
}

/** Total market value of everything in this gear object. */
function gearTotalValue(gear) {
  let total = 0;
  for (const k of GEAR_SLOT_KEYS) {
    const t = gear?.[k] || 0;
    if (t) total += gearPrice(k, t);
  }
  return total;
}

/** True iff every slot holds a +5 item. */
function gearIsLootLord(gear) {
  return GEAR_SLOT_KEYS.every(k => gear?.[k] === 5);
}

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

// One-shot migration: any player with non-empty `swords` (legacy sword
// inventory from the old auto-invest system) gets the full market value
// refunded to chips and their swords cleared. Runs once per boot — if
// no legacy data remains, this is a no-op.
function migrateLegacySwords() {
  const legacy = db.prepare("SELECT player_id, chips, swords FROM players WHERE swords != '{}' AND swords IS NOT NULL").all();
  if (legacy.length === 0) return;
  let totalRefund = 0;
  const tx = db.transaction(() => {
    for (const row of legacy) {
      let inv = {};
      try { inv = JSON.parse(row.swords) || {}; } catch { continue; }
      let refund = 0;
      for (const tierStr of Object.keys(inv)) {
        const tier = Number(tierStr);
        const count = Number(inv[tierStr]) || 0;
        const price = ALL_SWORD_PRICES_LEGACY[tier] || 0;
        refund += price * count;
      }
      if (refund <= 0) continue;
      totalRefund += refund;
      db.prepare('UPDATE players SET chips = chips + ?, swords = \'{}\' WHERE player_id = ?')
        .run(refund, row.player_id);
    }
  });
  tx();
  console.log(`[poker] migrated legacy swords: refunded ${totalRefund.toLocaleString()} gp across ${legacy.length} player(s); swords cleared`);
}
// Same numbers as the old ALL_SWORD_PRICES table — kept here so the
// migration above doesn't depend on the rest of the new gear system.
const ALL_SWORD_PRICES_LEGACY = { 1: 2315, 2: 8315, 3: 18315, 4: 32315, 5: 50315 };
migrateLegacySwords();

// One-shot migration: amulet slot was removed (5-slot game now). Any
// player carrying a +N amulet gets the FULL market price refunded
// (not the usual 50% hock value — this is a forced removal, not a
// player choice), and the amulet field is stripped from their gear.
// Idempotent: re-running finds nothing matching the LIKE filter.
const AMULET_PRICE = (tier) => 0 + tier * tier * 2000;  // mw=0, mult=2000
function migrateRemoveAmulet() {
  const rows = db.prepare("SELECT player_id, chips, gear FROM players WHERE gear LIKE '%amulet%'").all();
  if (rows.length === 0) return;
  let totalRefund = 0, affected = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      let gear = {};
      try { gear = JSON.parse(row.gear) || {}; } catch { continue; }
      if (!('amulet' in gear)) continue;
      const tier = Number(gear.amulet) || 0;
      const refund = tier > 0 ? AMULET_PRICE(tier) : 0;
      delete gear.amulet;
      db.prepare('UPDATE players SET chips = chips + ?, gear = ? WHERE player_id = ?')
        .run(refund, JSON.stringify(gear), row.player_id);
      totalRefund += refund;
      affected++;
    }
  });
  tx();
  console.log(`[poker] migrated: removed amulet slot, refunded ${totalRefund.toLocaleString()} gp across ${affected} player(s)`);
}
migrateRemoveAmulet();

// (Removed 2026-05-27: the migrateClearRebuyDebt() boot pass that used to
// zero out rebuy_debt on every restart. Debt tracking is back — owed to
// the First Bank of Abadar — so we let the column accumulate across boots
// like every other persisted state. The Loot Lord reset still clears
// everyone's debt to 0 (see Table.js _doFullReset), which is the only
// legitimate way to wipe it now.)

function seedRoster() {
  const now = Date.now();
  let humans = 0, bots = 0, prunedBots = 0;
  const updateBotAvatar = db.prepare('UPDATE players SET avatar_id = ? WHERE player_id = ? AND is_bot = 1');
  const updateBotMode   = db.prepare('UPDATE players SET bot_mode = ? WHERE player_id = ? AND is_bot = 1');
  const updateBotIntel  = db.prepare('UPDATE players SET bot_intelligence = ? WHERE player_id = ? AND is_bot = 1');
  // BOT_ROSTER entries may optionally specify a short display `nickname`
  // distinct from the canonical `name` (which is also the persistence key
  // / player_id). When the bot row already exists, we update its nickname
  // column so the seat label flips to the short form on the next render.
  // Player_id never changes, so chips/gear/history stay attached.
  const updateBotNick   = db.prepare('UPDATE players SET nickname = ? WHERE player_id = ? AND is_bot = 1');
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
      const displayNick = p.nickname || p.name;
      currentBotIds.add(id);
      const r = stmts.seedPlayer.run(id, displayNick, p.avatar, DEFAULT_STACK, now, now, 1, p.baseMode);
      if (r.changes) bots++;
      // Always sync the nickname (short label), avatar URL, mode, and
      // intelligence so BOT_ROSTER stays the source of truth for
      // character configuration. (Mode can drift between hands via
      // bot.maybeShiftMode(), but baseMode is what BOT_ROSTER pins.)
      updateBotNick.run(displayNick, id);
      updateBotAvatar.run(p.avatar, id);
      updateBotMode.run(p.baseMode || 'standard', id);
      updateBotIntel.run(p.intelligence || 'average', id);
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
/** Full roster snapshot for the lobby:roster event. Returns humans
 *  first (for the picker UI), then bots. The wealth-ranked
 *  leaderboard + bot picker on the client need this whole list, not
 *  just one half. */
function listAll()    { return [...listHumans(), ...listBots()]; }
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
function getSwords(playerId) {
  const p = stmts.getPlayer.get(playerId);
  if (!p) return {};
  try { return JSON.parse(p.swords || '{}') || {}; } catch { return {}; }
}
function setSwords(playerId, swords) {
  const json = JSON.stringify(swords || {});
  db.prepare('UPDATE players SET swords = ? WHERE player_id = ?').run(json, playerId);
}

// ---- Gear API ----
function getGear(playerId) {
  const p = stmts.getPlayer.get(playerId);
  if (!p) return {};
  try {
    const obj = JSON.parse(p.gear || '{}') || {};
    // Defensive normalization — clamp tiers to 0..5, null missing keys.
    const out = {};
    for (const k of GEAR_SLOT_KEYS) {
      const t = Math.floor(Number(obj[k]));
      out[k] = (Number.isFinite(t) && t >= 1 && t <= 5) ? t : null;
    }
    return out;
  } catch { return {}; }
}
function setGear(playerId, gear) {
  const json = JSON.stringify(gear || {});
  db.prepare('UPDATE players SET gear = ? WHERE player_id = ?').run(json, playerId);
}

// ---- Champions API ----
const insertChampion = db.prepare(`
  INSERT INTO champions (player_id, nickname, avatar_id, won_at, hands_to_win, final_chips)
  VALUES (?, ?, ?, ?, ?, ?)
`);
function recordChampion({ playerId, nickname, avatarId, handsToWin, finalChips }) {
  insertChampion.run(playerId, nickname, avatarId || null, Date.now(), handsToWin || null, finalChips || null);
}
function listChampions(limit = 50) {
  return db.prepare('SELECT * FROM champions ORDER BY won_at DESC LIMIT ?').all(limit);
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
  // Gear / Loot Lord
  GEAR_SLOTS,
  GEAR_SLOT_KEYS,
  GEAR_BY_KEY,
  gearPrice,
  gearPriceTable,
  gearHockValue,
  gearTotalValue,
  gearIsLootLord,
  getGear,
  setGear,
  recordChampion,
  listChampions,
  // Players
  getPlayer,
  listPlayers,
  listHumans,
  listBots,
  listAll,
  touchPlayer,
  setChips,
  addRebuyDebt,
  payRebuyDebt,
  getSwords,
  setSwords,
  recordWin,
  recordLoss,
  insertHand,
  recentHands,
};
